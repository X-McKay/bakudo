"""Compact run outputs into durable, evidence-backed memories (spec sections 14, 10.1).

A worker emits ``memories_to_write`` in its ``result.json``. Compaction turns
those into :class:`MemoryItem` candidates, attaches run provenance, and writes
them through the store's write policy — so only evidenced, non-secret,
sufficiently-confident, non-duplicate memories are retained.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..runner.result import RunResult
from .models import Evidence, MemoryItem
from .policy import MemoryRejected


def memories_from_result(
    result: RunResult, *, repo: str, created_by: str = "memory-curator@1"
) -> list[MemoryItem]:
    """Build memory candidates from a run's ``memories_to_write``."""
    items: list[MemoryItem] = []
    for raw in result.memories_to_write:
        evidence = [Evidence(run_id=result.run_id)]
        for ev in raw.evidence:
            if isinstance(ev, str):
                evidence.append(Evidence(path=ev))
            elif isinstance(ev, dict):
                evidence.append(Evidence(**{k: ev[k] for k in ev if k in Evidence.model_fields}))
        items.append(
            MemoryItem(
                type=raw.type,
                content=raw.content,
                scope={"repo": repo},
                evidence=evidence,
                confidence=raw.confidence,
                created_by=created_by,
            )
        )
    return items


@dataclass
class CompactionReport:
    written: list[str]
    rejected: list[dict[str, str]]


def compact(result: RunResult, store, *, repo: str) -> CompactionReport:
    """Write a run's memory candidates, recording acceptances and rejections.

    Stores that expose ``purge_expired()`` (the durable Pg store) get their
    TTL-expired rows deleted first (MEM-5) — compaction is the natural
    janitor moment, running after every run. Likewise, stores exposing
    ``flush_graph_mirror()`` get pending graph-mirror ops delivered (MEM-3),
    so a mirror backlog drains even when no further writes arrive.
    """
    purge = getattr(store, "purge_expired", None)
    if callable(purge):
        purge()
    flush = getattr(store, "flush_graph_mirror", None)
    if callable(flush):
        flush()
    written: list[str] = []
    rejected: list[dict[str, str]] = []
    for item in memories_from_result(result, repo=repo):
        try:
            stored = store.write_candidate(item)
            written.append(stored.id)
        except MemoryRejected as exc:
            rejected.append({"content": item.content, "reason": str(exc)})
    return CompactionReport(written=written, rejected=rejected)
