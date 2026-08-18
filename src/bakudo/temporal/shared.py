"""Serializable data contracts and constants shared by workflows/activities.

These are plain dataclasses (Temporal serialises them via its dataclass/JSON
converter) and contain no ``temporalio`` imports, so they are safe to import
anywhere — including inside the workflow sandbox.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from typing import Any

# Two task queues separate the trusted control plane from run orchestration.
TASK_QUEUE_CONTROL = "bakudo-control"
TASK_QUEUE_RUNS = "bakudo-runs"

_CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"


def deterministic_performance_id(prefix: str, operation_id: str, role: str) -> str:
    """Derive a retry-stable performance record ID from workflow input.

    The output intentionally has the same 26-character Crockford shape as
    Bakudo's generated ULIDs, while being content-derived rather than clock/
    randomness-derived.  Workflows use this before scheduling an activity so
    every Temporal retry addresses the same durable record.
    """
    if prefix not in {"measurement", "snapshot", "comparison"}:
        raise ValueError(f"unsupported performance id prefix: {prefix!r}")
    if not operation_id.strip() or not role.strip():
        raise ValueError("operation_id and role must not be empty")
    value = int.from_bytes(
        hashlib.sha256(f"bakudo-performance-v1\0{operation_id}\0{role}".encode()).digest(),
        "big",
    ) % (32**26)
    encoded: list[str] = []
    for _ in range(26):
        value, remainder = divmod(value, 32)
        encoded.append(_CROCKFORD_ALPHABET[remainder])
    return f"{prefix}_{''.join(reversed(encoded))}"


# Default agent per objective type, used when an objective carries no
# ``suggestedAgents`` (TMP-3). Types with no sensible default (eval-author,
# skill-gen, critic-only flows without a critic agent...) resolve to None and
# the meta-agent dead-letters the objective instead of crashing.
DEFAULT_AGENT_BY_TYPE: dict[str, str] = {
    "explore": "explore",
    "add-feature": "add-feature",
    "qa": "qa",
    "critic": "critic",
    "maintenance": "add-feature",
    "optimize": "optimize-scout",
}


def resolve_agent_name(objective: dict[str, Any]) -> str | None:
    """Deterministically resolve the agent name for an objective (TMP-3).

    Order: ``suggestedAgents[0]`` (what observer objectives carry), then the
    per-type default mapping. Returns ``None`` when unresolvable — the caller
    dead-letters, never crashes. Pure and import-safe for workflow code.
    """
    suggested = objective.get("suggestedAgents") or objective.get("suggested_agents")
    if isinstance(suggested, list) and suggested and isinstance(suggested[0], str):
        return suggested[0]
    obj_type = objective.get("type")
    if isinstance(obj_type, str):
        return DEFAULT_AGENT_BY_TYPE.get(obj_type)
    return None


@dataclass
class AgentRunInput:
    """Start one agent spec against one objective in one sandbox."""

    run_id: str
    objective: dict[str, Any]  # Objective.to_dict()
    agent_spec: dict[str, Any]  # AgentSpec schema document
    memory_excerpts: list[dict[str, Any]] = field(default_factory=list)
    eval_rubric: dict[str, Any] = field(default_factory=dict)
    timeout_seconds: int = 3600


@dataclass
class AgentRunOutput:
    run_id: str
    phase: str
    agent_ref: str
    git_branch: str
    result: dict[str, Any] | None = None
    scorecard: dict[str, Any] | None = None
    eval_results: list[dict[str, Any]] = field(default_factory=list)
    # The collected worktree diff. The agent branch does not survive sandbox
    # cleanup, so this is the only re-benchable artifact (issue #28).
    diff: str = ""
    denied_commands: list[dict[str, str]] = field(default_factory=list)
    # Wall-clock sandbox runtime (F3 fix): threaded through so TrialWorkflow
    # (which only sees this output, not the sandbox activity dict itself) can
    # populate TrialRecord.metrics["duration_s"], matching the sync run_trial
    # path's keys.
    runtime_seconds: float = 0.0


@dataclass
class EvalInput:
    """Run the eval suite against a collected run."""

    run_id: str
    objective: dict[str, Any]
    result: dict[str, Any]
    diff: str = ""
    denied_commands: list[dict[str, str]] = field(default_factory=list)
    runtime_seconds: float = 0.0
    tokens_used: int = 0
    schema_valid: bool = True


@dataclass
class PromotionInput:
    """Compare a candidate scorecard against a baseline and decide."""

    candidate: dict[str, Any]  # Scorecard dump
    baseline: dict[str, Any] | None = None
    mutation_kinds: list[str] = field(default_factory=list)


@dataclass
class EvolutionInput:
    """Score a candidate spec against the configured benchmark tasks."""

    baseline_spec: dict[str, Any]
    candidate_spec: dict[str, Any]


@dataclass
class CompactionInput:
    """Compact one run's emitted memories into the durable store."""

    repo: str
    result: dict[str, Any]


@dataclass
class ObserveInput:
    """Collect repository signals and emit candidate objectives."""

    repo: str


@dataclass
class TrialInput:
    """Run one task against one agent version and record a TrialRecord
    (experiment substrate design doc section 6, Temporal-shaped)."""

    task: str  # task ref or bare name
    agent: str  # agent ref, NAME or NAME@VERSION
    seed: int
    experiment_id: str | None = None


@dataclass
class ExperimentInput:
    """Drive one experiment's paired trial matrix through TrialWorkflow
    children and assemble the comparison result (experiment substrate design
    doc section 7)."""

    spec: dict[str, Any]  # the validated ExperimentSpec, JSON-shaped
    # Set when the meta-agent dispatched this experiment: the id to signal
    # run_completed with so its active_runs drains (mirrors
    # OptimizeInput.tracking_run_id / OptimizationWorkflow._notify_meta).
    # Nothing in this codebase dispatches an experiment from the meta-agent
    # today, but the field keeps ExperimentWorkflow's _notify_meta path
    # structurally identical for when that lands.
    tracking_run_id: str | None = None


@dataclass
class OptimizeInput:
    """Drive one optimize objective through scout → attempts → selection."""

    objective: dict[str, Any]  # Objective.to_dict(), type "optimize"
    scout_spec: dict[str, Any]  # optimize-scout AgentSpec document
    attempt_spec: dict[str, Any]  # optimize-attempt AgentSpec document
    max_rounds: int = 2
    max_approaches: int = 3
    timeout_seconds: int = 3600
    # Set when the meta-agent dispatched this loop (TMP-19): the id to signal
    # run_completed with so the meta-agent's active_runs drains. None when the
    # loop was started out-of-band (bakudo optimize / POST /optimize).
    tracking_run_id: str | None = None


# --- Performance measurement and diagnostic profiling ---


@dataclass(frozen=True)
class PerformanceMeasurementInput:
    """Pinned request for one uninstrumented measurement workflow."""

    operation_id: str
    workload: str
    revision: dict[str, Any]
    environment: dict[str, Any]
    workload_source: str | None = None
    workload_pin: dict[str, Any] | None = None
    integrity: dict[str, Any] = field(default_factory=dict)
    measurement_id: str | None = None


@dataclass(frozen=True)
class PerformanceCaptureInput:
    """Pinned request for one diagnostic profiler capture workflow."""

    operation_id: str
    workload: str
    revision: dict[str, Any]
    environment: dict[str, Any]
    profiler: str
    workload_source: str | None = None
    workload_pin: dict[str, Any] | None = None
    snapshot_id: str | None = None


@dataclass(frozen=True)
class PerformanceComparisonInput:
    """Pinned request for a fresh paired baseline/candidate comparison."""

    operation_id: str
    workload: str
    baseline_revision: dict[str, Any]
    candidate_revision: dict[str, Any]
    baseline_environment: dict[str, Any]
    candidate_environment: dict[str, Any]
    seed: int
    workload_source: str | None = None
    workload_pin: dict[str, Any] | None = None
    candidate_patch: str | None = None
    primary_metric: str | None = None
    protected_metrics: list[str] = field(default_factory=list)
    confidence: float = 0.95
    bootstrap_resamples: int = 10_000
    integrity: dict[str, Any] = field(default_factory=dict)
    allow_bakudo_patch_difference: bool = False
    allow_abox_patch_difference: bool = False
    baseline_measurement_id: str | None = None
    candidate_measurement_id: str | None = None
    comparison_id: str | None = None


@dataclass(frozen=True)
class PerformanceWorkflowResult:
    """JSON-shaped terminal result shared by all performance workflows."""

    operation_id: str
    kind: str
    status: str
    record_id: str | None = None
    record: dict[str, Any] | None = None
    related_records: dict[str, dict[str, Any]] = field(default_factory=dict)
    reason: str | None = None
