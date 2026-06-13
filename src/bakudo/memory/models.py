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
    relational = "relational_memory"  # graph relationships (Neo4j)
    # Worker-emitted shorthand types (from result.json) map onto semantic.
    repo_fact = "repo_fact"


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
