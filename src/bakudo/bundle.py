"""The task bundle handed to a worker run (spec section 5.3).

The control plane renders a :class:`TaskBundle` and writes its parts into the
sandbox mount (``/abox-meta/``); the worker agent receives *only* the
information required for the current objective. The bundle is also the unit the
:class:`bakudo.abox.runner.AboxRunner` materialises onto disk.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from .agent_spec import AgentSpec, dump_yaml
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
    eval_rubric: dict[str, Any] = Field(default_factory=dict)
    budget: Budget = Field(default_factory=Budget)

    @property
    def allowed_tools(self) -> list[str]:
        return sorted(self.agent_spec.tool_names())

    @property
    def allowed_skills(self) -> list[str]:
        return list(self.agent_spec.skills)

    @property
    def allowed_mcp_servers(self) -> list[str]:
        return [m.name for m in self.agent_spec.mcp_servers]

    def agent_yaml(self) -> str:
        return dump_yaml(self.agent_spec)

    def objective_json(self) -> dict[str, Any]:
        return self.objective.to_dict()
