"""Ledger record models and the run lifecycle phases (spec sections 12.1, 20)."""

from __future__ import annotations

from datetime import UTC, datetime
from enum import Enum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from .. import ids


class RunPhase(str, Enum):
    """The agent run phases (spec section 12.1)."""

    created = "created"
    bundle_rendered = "bundle_rendered"
    sandbox_starting = "sandbox_starting"
    agent_running = "agent_running"
    collecting_artifacts = "collecting_artifacts"
    evaluating = "evaluating"
    completed = "completed"
    failed = "failed"
    cancelled = "cancelled"
    archived = "archived"

    @property
    def is_terminal(self) -> bool:
        return self in {
            RunPhase.completed,
            RunPhase.failed,
            RunPhase.cancelled,
            RunPhase.archived,
        }

    @property
    def order(self) -> int:
        """Position in the forward lifecycle (terminal phases share the end)."""
        return _RUN_PHASE_ORDER[self]

    def can_transition_to(self, other: RunPhase) -> bool:
        """Whether ``self -> other`` is a legal lifecycle move.

        Rules: the run only moves *forward* through the pipeline phases
        (skipping intermediates is fine — the sync driver skips
        ``sandbox_starting``); ``failed``/``cancelled`` are reachable from any
        non-terminal phase; ``archived`` only from another terminal phase; and
        terminal phases never move except into ``archived``.
        """
        if self.is_terminal:
            return other is RunPhase.archived and self is not RunPhase.archived
        if other in (RunPhase.failed, RunPhase.cancelled):
            return True
        if other is RunPhase.archived:
            return False
        return other.order > self.order


# Forward lifecycle positions used by can_transition_to.
_RUN_PHASE_ORDER: dict[RunPhase, int] = {
    RunPhase.created: 0,
    RunPhase.bundle_rendered: 1,
    RunPhase.sandbox_starting: 2,
    RunPhase.agent_running: 3,
    RunPhase.collecting_artifacts: 4,
    RunPhase.evaluating: 5,
    RunPhase.completed: 6,
    RunPhase.failed: 6,
    RunPhase.cancelled: 6,
    RunPhase.archived: 7,
}


def _now() -> datetime:
    return datetime.now(UTC)


class AgentVersionRecord(BaseModel):
    """A row of ``agent_spec_versions`` (spec section 20)."""

    id: str = Field(default_factory=ids.agent_version_id)
    name: str
    version: int
    spec_yaml: str
    status: str  # candidate | canary | active | archived
    parent_version: int | None = None
    created_by: str = "meta-agent"
    created_at: datetime = Field(default_factory=_now)


class RunEvent(BaseModel):
    """A row of ``run_events`` — the durable event log (spec section 17.1)."""

    run_id: str
    event_type: str
    payload: dict[str, Any] = Field(default_factory=dict)
    ts: datetime = Field(default_factory=_now)


class RunRecord(BaseModel):
    """A row of ``runs`` (spec section 20)."""

    model_config = ConfigDict(use_enum_values=False)

    id: str = Field(default_factory=ids.run_id)
    temporal_workflow_id: str
    abox_task_id: str
    objective_id: str
    agent_ref: str  # name@version
    phase: RunPhase = RunPhase.created
    git_branch: str | None = None
    started_at: datetime | None = None
    completed_at: datetime | None = None
    result: dict[str, Any] | None = None
