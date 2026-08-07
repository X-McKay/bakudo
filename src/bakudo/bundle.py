"""The task bundle handed to a worker run (spec section 5.3).

The control plane renders a :class:`TaskBundle` and writes its parts into the
sandbox mount (``/abox-meta/``); the worker agent receives *only* the
information required for the current objective. The bundle is also the unit the
:class:`bakudo.abox.runner.AboxRunner` materialises onto disk.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from .agent_spec import AgentSpec
from .curriculum.objective import Objective


class Budget(BaseModel):
    """Hard limits for a single run."""

    model_config = ConfigDict(populate_by_name=True)

    timeout_seconds: int = Field(default=3600, alias="timeoutSeconds", ge=1)
    max_tokens: int | None = Field(default=None, alias="maxTokens", ge=1)
    max_usd: float | None = Field(default=None, alias="maxUsd", ge=0)


class MemoryExcerpt(BaseModel):
    """A retrieved memory item, trimmed for prompt inclusion."""

    id: str
    type: str
    content: str
    confidence: float = 0.0


class TaskBundle(BaseModel):
    """Everything a worker run needs, and nothing more."""

    model_config = ConfigDict(populate_by_name=True)

    run_id: str
    objective_id: str
    objective: Objective
    agent_spec: AgentSpec
    memory_excerpts: list[MemoryExcerpt] = Field(default_factory=list)
    budget: Budget = Field(default_factory=Budget)

    @property
    def allowed_tools(self) -> list[str]:
        return sorted(self.agent_spec.tool_names())

    @property
    def allowed_skills(self) -> list[str]:
        return list(self.agent_spec.skills)

    def memory_query(self, query: str) -> list[dict[str, Any]]:
        """Retrieve from the excerpts pre-loaded into this bundle.

        The worker runs in a sandbox without control-plane access, so the
        ``query-memory`` tool is backed by the memories the control plane
        already selected and shipped in the bundle (a case-insensitive
        substring match in v0.1).
        """
        q = query.strip().lower()
        matches = [m for m in self.memory_excerpts if not q or q in m.content.lower()]
        return [m.model_dump(mode="json") for m in matches]
