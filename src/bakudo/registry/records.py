"""Ledger record models and the run lifecycle phases (spec sections 12.1, 20)."""

from __future__ import annotations

from datetime import UTC, datetime
from enum import Enum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator

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


def _now() -> datetime:
    return datetime.now(UTC)


# The version lifecycle state machine (promotion design 2026-08-09 §1):
#
#   candidate ──decide()──► rejected | pending_human | canary
#   pending_human ──approve──► canary        ──reject──► rejected
#   canary ──graduate──► active (old active → archived)
#   canary ──rollback──► rejected
#   active ──superseded──► archived
VERSION_STATUSES: tuple[str, ...] = (
    "candidate",
    "pending_human",
    "canary",
    "active",
    "rejected",
    "archived",
)


class AgentVersionRecord(BaseModel):
    """A row of ``agent_spec_versions`` (spec section 20)."""

    id: str = Field(default_factory=ids.agent_version_id)
    name: str
    version: int
    spec_yaml: str
    status: str  # one of VERSION_STATUSES
    status_reason: str | None = None
    decided_at: datetime | None = None
    parent_version: int | None = None
    created_by: str = "meta-agent"
    created_at: datetime = Field(default_factory=_now)

    @field_validator("status")
    @classmethod
    def _known_status(cls, value: str) -> str:
        if value not in VERSION_STATUSES:
            raise ValueError(
                f"unknown version status {value!r}; expected one of {VERSION_STATUSES}"
            )
        return value


class RunEvent(BaseModel):
    """A row of ``run_events`` — the durable event log (spec section 17.1).

    ``idem_key`` is a caller-computed idempotency key (TMP-8): a retried
    activity re-issues the same logical event, and durable backends drop the
    duplicate via ``unique (run_id, idem_key)``. ``None`` means "always
    append".
    """

    run_id: str
    event_type: str
    payload: dict[str, Any] = Field(default_factory=dict)
    ts: datetime = Field(default_factory=_now)
    idem_key: str | None = None


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


class RepoRecord(BaseModel):
    """A row of ``repos``: a deliberately onboarded repository checkout
    (repo onboarding, P2 Task 1). ``name`` is the key
    :meth:`bakudo.abox.runner.AboxRunner.resolve_repo` looks up first
    (registry-first), falling back to ``$BAKUDO_REPO_ROOT/<name>`` when a
    name has no registry entry -- so ``name`` must match the bare
    ``objective.repo`` a run wants to resolve against this checkout.
    """

    name: str
    source: str  # the URL or original local path passed to `bakudo repo add`
    path: str  # resolved absolute checkout path
    default_base_ref: str = "main"
    added_at: str | None = None
    provenance: dict[str, Any] = Field(default_factory=dict)
