"""Trial record models (experiment substrate design doc section 6).

A :class:`TrialRecord` is one scenario execution by one agent version: the
measurement-side counterpart to :class:`~bakudo.registry.records.RunRecord`
(a run is the execution mechanics; a trial is the scored outcome an
experiment aggregates over). Field names are plain snake_case — this is a
registry-record model (see :mod:`bakudo.registry.records`), not a
camelCase-aliased spec model like :mod:`bakudo.agent_spec.models`.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class HackFlags(_Strict):
    """Heuristic signals that a trial gamed its scenario rather than solving
    it (experiment substrate design doc section 6): editing the hidden test
    files, retrying a denied action until it slipped through, or touching
    paths outside the scenario's declared scope."""

    test_path_violation: bool = False
    denied_action_retries: bool = False
    scope_violation: bool = False
    details: dict[str, str] = {}


class TrialRecord(_Strict):
    """A row of ``trials``: one agent-version run of one scenario version."""

    id: str  # trial_…
    experiment_id: str | None = None
    run_id: str | None = None
    objective_id: str | None = None
    agent_ref: str  # name@version
    scenario_name: str
    scenario_version: int
    scenario_digest: str
    seed: int
    pins: dict[str, str] = {}  # bakudo/abox/model/profile versions
    metrics: dict[str, float] = {}  # tokens, tool_calls, duration_s, changed_files, diff_bytes …
    evaluation: dict = {}  # scorecard dict, f2p_rate, p2p_rate, expectations
    flags: HackFlags = HackFlags()
    status: str  # completed | failed
    started_at: str | None = None
    completed_at: str | None = None
