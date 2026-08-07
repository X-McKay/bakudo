"""Select memory excerpts for a task bundle — the memory *read* path (§14).

The worker runs in a sandbox without control-plane access, so the control
plane retrieves relevant memories at bundle-render time and ships them inside
the :class:`~bakudo.bundle.TaskBundle`; the worker's ``query-memory`` tool
then searches only those excerpts.
"""

from __future__ import annotations

from typing import Any

from ..bundle import MemoryExcerpt
from ..curriculum.objective import Objective

DEFAULT_EXCERPT_LIMIT = 5


def retrieve_excerpts(
    memory: Any,
    objective: Objective,
    *,
    limit: int = DEFAULT_EXCERPT_LIMIT,
) -> list[MemoryExcerpt]:
    """Query a memory store for items relevant to an objective.

    Works against any store implementing the :class:`MemoryStore` protocol;
    stores with semantic search (``query(text=...)``) rank by similarity to
    the objective's title and description, the rest fall back to
    confidence-ranked retrieval.
    """
    if memory is None:
        return []
    query_text = f"{objective.title}\n{objective.description}".strip()
    try:
        items = memory.query(text=query_text, limit=limit)
    except TypeError:
        items = memory.query(limit=limit)
    return [
        MemoryExcerpt(
            id=item.id,
            type=str(item.type),
            content=item.content,
            confidence=item.confidence,
        )
        for item in items
    ]
