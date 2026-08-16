"""Memory record shapes (spec sections 14.3, 14.4)."""

from __future__ import annotations

from enum import Enum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from .. import ids


class MemoryType(str, Enum):
    episodic = "episodic_memory"      # what happened in a run
    semantic = "semantic_memory"      # stable repo/domain/API facts
    procedural = "procedural_memory"  # skills, workflows, recipes
    evaluative = "evaluative_memory"  # what made outputs good/bad
    relational = "relational_memory"  # graph relationships (FalkorDB)
    # Worker-emitted shorthand types (from result.json) map onto semantic.
    repo_fact = "repo_fact"

    @classmethod
    def canonical(cls, raw: str) -> str:
        """Normalise a worker-emitted type string to a stable vocabulary value
        (MEM-21). Recognised canonical values (``semantic_memory``) and enum
        member names (``semantic``) pass through to their canonical value; the
        ``repo_fact`` shorthand — and any string outside the vocabulary — maps
        onto ``semantic_memory``, applying the mapping the docstring above (and
        compaction) always claimed but never enforced. Empty input also maps to
        semantic. This is applied on the worker → compaction path; directly
        constructed :class:`MemoryItem` objects keep whatever ``type`` they are
        given (the field stays a free ``str`` so existing callers are
        unaffected)."""
        if not raw:
            return cls.semantic.value
        try:
            member = cls(raw)
        except ValueError:
            member = cls.__members__.get(raw, cls.semantic)
        return cls.semantic.value if member is cls.repo_fact else member.value


class Evidence(BaseModel):
    """A pointer to the artifact/run/line range that supports a memory."""

    model_config = ConfigDict(extra="allow")

    artifact_id: str | None = None
    run_id: str | None = None
    path: str | None = None
    line_range: list[int] | None = None


class MemoryItem(BaseModel):
    """An evidence-backed memory candidate or stored memory."""

    model_config = ConfigDict(populate_by_name=True)

    id: str = Field(default_factory=ids.memory_id)
    type: str
    content: str
    scope: dict[str, Any] = Field(default_factory=dict)
    evidence: list[Evidence] = Field(default_factory=list)
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    ttl: str | None = None  # e.g. "180d"
    created_by: str = "memory-curator@1"

    def to_dict(self) -> dict[str, Any]:
        return self.model_dump(mode="json", exclude_none=True)
