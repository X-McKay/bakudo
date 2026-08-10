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
    # Issue #27: tool-call ceiling that force-transitions the run into the
    # report phase with wall clock to spare.
    max_tool_calls: int | None = Field(default=None, alias="maxToolCalls", ge=1)


def budget_from_spec(spec: Any) -> Budget:
    """Derive the run :class:`Budget` from an agent spec (review finding API-3).

    ``timeoutSeconds`` always comes from ``spec.sandbox.timeoutSeconds`` — it is
    the single wall-clock number shared by the abox ``--timeout`` and the
    in-guest deadline. Token/cost caps are read from an optional ``spec.budget``
    (``max_tokens``/``maxTokens``, ``max_usd``/``maxUsd``) when a spec carries
    one; the current v1alpha1 AgentSpec schema does not define run-level budget
    fields yet, so these default to ``None`` for schema-validated specs.

    This is the single budget-construction point for every bundle producer
    (control/pipeline, runner/main, temporal/_impl).
    """

    def _first(obj: Any, *names: str) -> Any:
        for name in names:
            value = getattr(obj, name, None)
            if value is not None:
                return value
        return None

    spec_budget = getattr(spec, "budget", None)
    max_tokens = max_usd = max_tool_calls = None
    if spec_budget is not None:
        max_tokens = _first(spec_budget, "max_tokens", "maxTokens")
        max_usd = _first(spec_budget, "max_usd", "maxUsd")
        max_tool_calls = _first(spec_budget, "max_tool_calls", "maxToolCalls")
    return Budget(
        timeoutSeconds=int(spec.sandbox.timeout_seconds),
        maxTokens=max_tokens,
        maxUsd=max_usd,
        maxToolCalls=max_tool_calls,
    )


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
