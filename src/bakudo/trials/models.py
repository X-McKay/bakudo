"""Trial record models (experiment substrate design doc section 6).

A :class:`TrialRecord` is one task execution by one agent version: the
measurement-side counterpart to :class:`~bakudo.registry.records.RunRecord`
(a run is the execution mechanics; a trial is the scored outcome an
experiment aggregates over). Field names are plain snake_case — this is a
registry-record model (see :mod:`bakudo.registry.records`), not a
camelCase-aliased spec model like :mod:`bakudo.agent_spec.models`.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field

from ..tasks.models import TaskPin


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class IntegrityFlags(_Strict):
    """Hard-constraint or evaluation-integrity violations for one episode."""

    verifier_input_violation: bool = False
    denied_action_violation: bool = False
    scope_violation: bool = False
    change_limit_violation: bool = False
    details: dict[str, str] = Field(default_factory=dict)


class TrialRecord(_Strict):
    """Experimental measurement of exactly one environment episode."""

    id: str  # trial_…
    episode_id: str  # episode_…
    experiment_id: str | None = None
    run_id: str | None = None
    objective_id: str | None = None
    agent_ref: str  # name@version
    task: TaskPin
    seed: int
    runtime_pins: dict[str, str] = Field(default_factory=dict)
    metrics: dict[str, float] = Field(default_factory=dict)
    evaluation: dict = Field(default_factory=dict)
    integrity: IntegrityFlags = Field(default_factory=IntegrityFlags)
    status: str  # completed | failed
    started_at: str | None = None
    completed_at: str | None = None
