"""Pure regression lifecycle policy and structured optimization evidence.

The reducer in this module consumes only persisted ``PerformanceComparison``
records.  It does not run workloads, inspect agent reports, or infer a win from
profiled timing.  State and comparison storage are narrow ports so confidence,
hysteresis, cooldown, and deduplication can be tested without Temporal or a
database.
"""

from __future__ import annotations

import hashlib
import math
import re
from collections.abc import Callable, Sequence
from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta
from enum import Enum
from pathlib import PurePosixPath
from typing import Literal, Protocol, cast

from pydantic import BaseModel, ConfigDict, Field

from .. import ids
from .models import (
    MetricComparison,
    MetricName,
    PerformanceComparison,
    PerformanceRegressionSignal,
    RecordStatus,
    Verdict,
    WorkloadRef,
)
from .pins import WorkloadPin


class RegressionPhase(str, Enum):
    clear = "clear"
    pending = "pending"
    active = "active"
    cooldown = "cooldown"


class RegressionDecisionReason(str, Enum):
    emitted = "emitted"
    pending = "pending"
    duplicate_observation = "duplicate-observation"
    already_active = "already-active"
    recovered = "recovered"
    cooling_down = "cooling-down"
    inconclusive = "inconclusive"
    invalid_comparison = "invalid-comparison"
    unapproved_workload = "unapproved-workload"
    insufficient_confidence = "insufficient-confidence"
    insufficient_samples = "insufficient-samples"
    below_threshold = "below-threshold"
    concurrency_limited = "concurrency-limited"


@dataclass(frozen=True)
class ApprovedWorkload:
    """An exact workload pin approved for autonomous regression collection."""

    pin: WorkloadPin
    baseline_policy: str
    baseline_commit_shas: tuple[str, ...] = ()
    criticality: float = 0.5
    estimated_cost: float = 0.25
    risk: float = 0.25
    autonomous: bool = True

    def __post_init__(self) -> None:
        if not self.baseline_policy.strip():
            raise ValueError("baseline_policy must not be empty")
        for name, value in (
            ("criticality", self.criticality),
            ("estimated_cost", self.estimated_cost),
            ("risk", self.risk),
        ):
            if not math.isfinite(value) or not 0 <= value <= 1:
                raise ValueError(f"{name} must be finite and between 0 and 1")
        if len(self.baseline_commit_shas) != len(set(self.baseline_commit_shas)):
            raise ValueError("baseline_commit_shas cannot contain duplicates")
        if any(
            re.fullmatch(r"[0-9a-f]{40,64}", commit) is None
            for commit in self.baseline_commit_shas
        ):
            raise ValueError("baseline_commit_shas must contain lowercase git object IDs")


@dataclass(frozen=True)
class RegressionPolicy:
    """Confidence, recurrence, hysteresis, and resource policy."""

    minimum_relative_regression: float = 0.05
    recovery_relative_threshold: float = 0.02
    minimum_confidence: float = 0.95
    minimum_samples: int = 5
    consecutive_observations: int = 2
    cooldown: timedelta = timedelta(hours=24)
    max_active_signals_per_repository: int = 1
    split_by_hotspot: bool = False

    def __post_init__(self) -> None:
        for name, value in (
            ("minimum_relative_regression", self.minimum_relative_regression),
            ("recovery_relative_threshold", self.recovery_relative_threshold),
            ("minimum_confidence", self.minimum_confidence),
        ):
            if not math.isfinite(value):
                raise ValueError(f"{name} must be finite")
        if self.minimum_relative_regression <= 0:
            raise ValueError("minimum_relative_regression must be positive")
        if not 0 <= self.recovery_relative_threshold < self.minimum_relative_regression:
            raise ValueError(
                "recovery_relative_threshold must be non-negative and below create threshold"
            )
        if not 0 < self.minimum_confidence < 1:
            raise ValueError("minimum_confidence must be between 0 and 1")
        if self.minimum_samples < 1:
            raise ValueError("minimum_samples must be at least 1")
        if self.consecutive_observations < 1:
            raise ValueError("consecutive_observations must be at least 1")
        if self.cooldown < timedelta(0):
            raise ValueError("cooldown must not be negative")
        if self.max_active_signals_per_repository < 1:
            raise ValueError("max_active_signals_per_repository must be at least 1")


@dataclass(frozen=True)
class RegressionState:
    """Small persistence-neutral lifecycle state for one deduplication key."""

    repository: str
    deduplication_key: str
    phase: RegressionPhase = RegressionPhase.clear
    consecutive_regressions: int = 0
    last_comparison_at: datetime | None = None
    last_comparison_id: str | None = None
    active_signal_id: str | None = None
    cooldown_until: datetime | None = None

    def __post_init__(self) -> None:
        if self.consecutive_regressions < 0:
            raise ValueError("consecutive_regressions must not be negative")
        for value in (self.last_comparison_at, self.cooldown_until):
            if value is not None and (value.tzinfo is None or value.utcoffset() is None):
                raise ValueError("regression state timestamps must be timezone-aware")
        if self.phase is RegressionPhase.active and self.active_signal_id is None:
            raise ValueError("active state requires active_signal_id")
        if self.phase is RegressionPhase.cooldown and self.cooldown_until is None:
            raise ValueError("cooldown state requires cooldown_until")


@dataclass(frozen=True)
class RegressionDecision:
    state: RegressionState
    reason: RegressionDecisionReason
    signal: PerformanceRegressionSignal | None = None
    details: tuple[str, ...] = ()


class PerformanceComparisonSource(Protocol):
    def list_performance_comparisons(
        self,
        repository: str | None = None,
        workload_ref: str | None = None,
    ) -> list[PerformanceComparison]: ...


class RegressionStateStore(Protocol):
    def get(self, repository: str, deduplication_key: str) -> RegressionState | None: ...

    def put(self, state: RegressionState) -> None: ...

    def list(self, repository: str) -> tuple[RegressionState, ...]: ...


class InMemoryRegressionStateStore:
    """Deterministic state adapter for tests and synchronous composition."""

    def __init__(self) -> None:
        self._states: dict[tuple[str, str], RegressionState] = {}

    def get(self, repository: str, deduplication_key: str) -> RegressionState | None:
        return self._states.get((repository, deduplication_key))

    def put(self, state: RegressionState) -> None:
        self._states[(state.repository, state.deduplication_key)] = state

    def list(self, repository: str) -> tuple[RegressionState, ...]:
        return tuple(
            sorted(
                (state for (repo, _key), state in self._states.items() if repo == repository),
                key=lambda state: state.deduplication_key,
            )
        )


def regression_deduplication_key(
    repository: str,
    approval: ApprovedWorkload,
    metric_name: str,
    *,
    top_hotspot_key: str | None = None,
    split_by_hotspot: bool = False,
) -> str:
    """Return a stable opaque key without exposing workload or symbol details."""

    parts = (
        repository,
        approval.pin.bundle_digest,
        metric_name,
        approval.baseline_policy,
        top_hotspot_key if split_by_hotspot else None,
    )
    payload = "\x1f".join("" if part is None else part for part in parts).encode()
    return f"performance:v1:sha256:{hashlib.sha256(payload).hexdigest()}"


def _signal_id(deduplication_key: str, comparison_id: str) -> str:
    return ids.deterministic_regression_id(f"{deduplication_key}\x1f{comparison_id}")


def _primary_metric(comparison: PerformanceComparison) -> MetricComparison | None:
    return next(
        (
            metric
            for metric in comparison.metrics
            if metric.metric_name == comparison.primary_metric
        ),
        None,
    )


def _cursor_is_duplicate(state: RegressionState, comparison: PerformanceComparison) -> bool:
    if state.last_comparison_at is None or state.last_comparison_id is None:
        return False
    return (comparison.created_at, comparison.id) <= (
        state.last_comparison_at,
        state.last_comparison_id,
    )


_UNSET = object()


def _advance(
    state: RegressionState,
    comparison: PerformanceComparison,
    *,
    phase: RegressionPhase | None = None,
    consecutive_regressions: int | None = None,
    active_signal_id: str | None | object = _UNSET,
    cooldown_until: datetime | None | object = _UNSET,
) -> RegressionState:
    return RegressionState(
        repository=state.repository,
        deduplication_key=state.deduplication_key,
        phase=phase or state.phase,
        consecutive_regressions=(
            state.consecutive_regressions
            if consecutive_regressions is None
            else consecutive_regressions
        ),
        last_comparison_at=comparison.created_at,
        last_comparison_id=comparison.id,
        active_signal_id=(
            state.active_signal_id
            if active_signal_id is _UNSET
            else cast(str | None, active_signal_id)
        ),
        cooldown_until=(
            state.cooldown_until
            if cooldown_until is _UNSET
            else cast(datetime | None, cooldown_until)
        ),
    )


def _validity_reason(
    comparison: PerformanceComparison,
    approval: ApprovedWorkload,
    policy: RegressionPolicy,
) -> tuple[RegressionDecisionReason | None, tuple[str, ...]]:
    if not approval.autonomous or comparison.workload != approval.pin:
        return RegressionDecisionReason.unapproved_workload, (
            "comparison workload pin is not approved for autonomous collection",
        )
    repository = comparison.baseline_revision.repository
    if comparison.candidate_revision.repository != repository:
        return RegressionDecisionReason.invalid_comparison, (
            "baseline and candidate repository pins differ",
        )
    if approval.baseline_commit_shas and (
        comparison.baseline_revision.commit_sha not in approval.baseline_commit_shas
    ):
        return RegressionDecisionReason.unapproved_workload, (
            "baseline revision is outside the approved baseline policy",
        )
    metric = _primary_metric(comparison)
    if metric is None:
        return RegressionDecisionReason.invalid_comparison, (
            "comparison has no primary metric evidence",
        )
    invalid = (
        comparison.status is not RecordStatus.completed
        or not comparison.integrity.valid
        or bool(comparison.incompatibilities)
        or comparison.baseline_environment.profiler_adapter is not None
        or comparison.candidate_environment.profiler_adapter is not None
        or not metric.valid
    )
    if invalid:
        return RegressionDecisionReason.invalid_comparison, (
            "comparison is incomplete, incompatible, profiled, or has invalid primary evidence",
        )
    if comparison.confidence < policy.minimum_confidence:
        return RegressionDecisionReason.insufficient_confidence, (
            f"confidence {comparison.confidence:g} is below {policy.minimum_confidence:g}",
        )
    if metric.sample_count < policy.minimum_samples:
        return RegressionDecisionReason.insufficient_samples, (
            f"sample count {metric.sample_count} is below {policy.minimum_samples}",
        )
    if (
        metric.relative_effect is None
        or metric.ci_lower is None
        or metric.ci_upper is None
        or comparison.verdict is not metric.verdict
    ):
        return RegressionDecisionReason.invalid_comparison, (
            "comparison primary verdict or effect fields are inconsistent",
        )
    return None, ()


def evaluate_regression(
    comparison: PerformanceComparison,
    approval: ApprovedWorkload,
    policy: RegressionPolicy,
    *,
    state: RegressionState | None = None,
    observed_at: datetime | None = None,
    top_hotspot_key: str | None = None,
) -> RegressionDecision:
    """Apply one comparison to lifecycle state and optionally emit one signal."""

    now = observed_at or datetime.now(UTC)
    if now.tzinfo is None or now.utcoffset() is None:
        raise ValueError("observed_at must be timezone-aware")
    if top_hotspot_key is not None and (not top_hotspot_key or len(top_hotspot_key) > 512):
        raise ValueError("top_hotspot_key must be non-empty and at most 512 characters")
    repository = comparison.baseline_revision.repository
    key = regression_deduplication_key(
        repository,
        approval,
        comparison.primary_metric,
        top_hotspot_key=top_hotspot_key,
        split_by_hotspot=policy.split_by_hotspot,
    )
    current = state or RegressionState(repository=repository, deduplication_key=key)
    if current.repository != repository or current.deduplication_key != key:
        raise ValueError("regression state does not match comparison deduplication key")
    if _cursor_is_duplicate(current, comparison):
        return RegressionDecision(current, RegressionDecisionReason.duplicate_observation)

    validity_reason, details = _validity_reason(comparison, approval, policy)
    if validity_reason is not None:
        advanced = _advance(
            current,
            comparison,
            phase=RegressionPhase.clear
            if current.phase is RegressionPhase.pending
            else current.phase,
            consecutive_regressions=0
            if current.phase is RegressionPhase.pending
            else current.consecutive_regressions,
        )
        if current.phase is RegressionPhase.cooldown:
            advanced = replace(advanced, cooldown_until=now + policy.cooldown)
        return RegressionDecision(advanced, validity_reason, details=details)

    metric = _primary_metric(comparison)
    assert metric is not None
    assert metric.relative_effect is not None
    assert metric.ci_upper is not None
    create_threshold = max(policy.minimum_relative_regression, metric.practical_threshold)
    regression_magnitude = -metric.relative_effect
    is_regression = (
        metric.verdict is Verdict.regressed
        and regression_magnitude >= create_threshold
        and metric.ci_upper < 0
    )
    is_recovered = (
        metric.verdict in {Verdict.equivalent, Verdict.improved}
        and metric.relative_effect >= -policy.recovery_relative_threshold
    )

    if is_regression:
        if current.phase is RegressionPhase.active:
            return RegressionDecision(
                _advance(
                    current,
                    comparison,
                    consecutive_regressions=current.consecutive_regressions + 1,
                ),
                RegressionDecisionReason.already_active,
            )
        if (
            current.phase is RegressionPhase.cooldown
            and current.cooldown_until is not None
            and now < current.cooldown_until
        ):
            return RegressionDecision(
                _advance(current, comparison),
                RegressionDecisionReason.cooling_down,
                details=(f"cooldown remains active until {current.cooldown_until.isoformat()}",),
            )

        count = current.consecutive_regressions + 1
        pending = _advance(
            current,
            comparison,
            phase=RegressionPhase.pending,
            consecutive_regressions=count,
            active_signal_id=None,
            cooldown_until=None,
        )
        if count < policy.consecutive_observations:
            return RegressionDecision(pending, RegressionDecisionReason.pending)

        signal_id = _signal_id(key, comparison.id)
        signal = PerformanceRegressionSignal(
            id=signal_id,
            created_at=now,
            repository=repository,
            workload=comparison.workload,
            metric_name=comparison.primary_metric,
            comparison_id=comparison.id,
            relative_regression=regression_magnitude,
            confidence=comparison.confidence,
            consecutive_observations=count,
            deduplication_key=key,
            top_hotspot_key=top_hotspot_key,
            approved=True,
        )
        active = replace(
            pending,
            phase=RegressionPhase.active,
            active_signal_id=signal.id,
        )
        return RegressionDecision(active, RegressionDecisionReason.emitted, signal=signal)

    if is_recovered:
        if current.phase is RegressionPhase.active:
            return RegressionDecision(
                _advance(
                    current,
                    comparison,
                    phase=RegressionPhase.cooldown,
                    consecutive_regressions=0,
                    active_signal_id=None,
                    cooldown_until=now + policy.cooldown,
                ),
                RegressionDecisionReason.recovered,
            )
        if current.phase is RegressionPhase.cooldown:
            if current.cooldown_until is not None and now < current.cooldown_until:
                return RegressionDecision(
                    _advance(current, comparison), RegressionDecisionReason.cooling_down
                )
        return RegressionDecision(
            _advance(
                current,
                comparison,
                phase=RegressionPhase.clear,
                consecutive_regressions=0,
                active_signal_id=None,
                cooldown_until=None,
            ),
            RegressionDecisionReason.recovered,
        )

    advanced = _advance(
        current,
        comparison,
        phase=RegressionPhase.clear
        if current.phase is RegressionPhase.pending
        else current.phase,
        consecutive_regressions=0
        if current.phase is RegressionPhase.pending
        else current.consecutive_regressions,
    )
    if current.phase is RegressionPhase.cooldown:
        advanced = replace(advanced, cooldown_until=now + policy.cooldown)
    reason = (
        RegressionDecisionReason.below_threshold
        if metric.verdict is Verdict.regressed
        else RegressionDecisionReason.inconclusive
    )
    return RegressionDecision(advanced, reason)


class _StrictFrozen(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)


class PerformanceDecisionPolicyInput(_StrictFrozen):
    confidence: float = Field(gt=0, lt=1)
    minimum_relative_improvement: float = Field(
        alias="minimumRelativeImprovement", gt=0
    )
    protected_metrics: tuple[MetricName, ...] = Field(
        default_factory=tuple, alias="protectedMetrics"
    )


class PerformanceEvidenceInput(_StrictFrozen):
    regression_signal_id: str = Field(alias="regressionSignalId")
    comparison_id: str = Field(alias="comparisonId")
    deduplication_key: str = Field(alias="deduplicationKey")


class StructuredPerformanceInput(_StrictFrozen):
    workload_ref: WorkloadRef = Field(alias="workloadRef")
    workload_pin: WorkloadPin = Field(alias="workloadPin")
    primary_metric: MetricName = Field(alias="primaryMetric")
    decision_policy: PerformanceDecisionPolicyInput = Field(alias="decisionPolicy")
    evidence: PerformanceEvidenceInput


class PerformanceObjectivePriorityInput(_StrictFrozen):
    value: float = Field(ge=0, le=1)
    urgency: float = Field(ge=0, le=1)
    confidence: float = Field(ge=0, le=1)
    risk: float = Field(ge=0, le=1)
    estimated_cost: float = Field(alias="estimatedCost", ge=0, le=1)


class PerformanceObjectiveInput(_StrictFrozen):
    """Schema-independent input for the optimize-objective cutover owner."""

    id: str
    type: Literal["optimize"] = "optimize"
    repo: str
    title: str
    description: str
    performance: StructuredPerformanceInput
    target_paths: tuple[str, ...] = Field(default_factory=tuple, alias="targetPaths")
    suggested_agents: tuple[str, ...] = Field(
        default=("explore", "optimize", "qa"), alias="suggestedAgents"
    )
    priority: PerformanceObjectivePriorityInput

    def to_dict(self) -> dict[str, object]:
        return self.model_dump(by_alias=True, exclude_none=True, mode="json")


def objective_input_from_signal(
    signal: PerformanceRegressionSignal,
    approval: ApprovedWorkload,
    policy: RegressionPolicy,
    *,
    target_paths: Sequence[str] = (),
    protected_metrics: Sequence[str] = (),
) -> PerformanceObjectiveInput:
    """Map an approved signal to pinned structured input, never a shell command."""

    if not signal.approved or signal.workload != approval.pin:
        raise ValueError("signal is not approved by the supplied workload policy")
    expected_key = regression_deduplication_key(
        signal.repository,
        approval,
        signal.metric_name,
        top_hotspot_key=signal.top_hotspot_key,
        split_by_hotspot=policy.split_by_hotspot,
    )
    if signal.deduplication_key != expected_key:
        raise ValueError("signal deduplication key does not match approval policy")
    normalized_paths: list[str] = []
    for value in target_paths:
        path = PurePosixPath(value)
        if (
            not value
            or "\\" in value
            or path.is_absolute()
            or ".." in path.parts
            or "." in path.parts
            or path.as_posix() != value
        ):
            raise ValueError("target_paths must contain normalized relative POSIX paths")
        normalized_paths.append(value)
    relative = min(1.0, signal.relative_regression)
    recurrence = min(
        1.0,
        signal.consecutive_observations / max(2, policy.consecutive_observations),
    )
    priority = PerformanceObjectivePriorityInput(
        value=min(1.0, 0.6 * approval.criticality + 0.4 * relative),
        urgency=min(1.0, 0.5 * relative + 0.5 * recurrence),
        confidence=signal.confidence,
        risk=approval.risk,
        estimated_cost=approval.estimated_cost,
    )
    return PerformanceObjectiveInput(
        id=ids.deterministic_objective_id(f"performance\x1f{signal.id}"),
        repo=signal.repository,
        title=f"Recover {signal.metric_name} performance for {signal.workload.ref}",
        description=(
            f"Independent comparison {signal.comparison_id} observed a "
            f"{signal.relative_regression:.1%} regression across "
            f"{signal.consecutive_observations} consecutive observations."
        ),
        performance=StructuredPerformanceInput(
            workload_ref=WorkloadRef(
                name=signal.workload.name,
                version=signal.workload.version,
                source=signal.workload.source_kind,
            ),
            workload_pin=signal.workload,
            primary_metric=signal.metric_name,
            decision_policy=PerformanceDecisionPolicyInput(
                confidence=max(policy.minimum_confidence, signal.confidence),
                minimum_relative_improvement=policy.minimum_relative_regression,
                protected_metrics=tuple(protected_metrics),
            ),
            evidence=PerformanceEvidenceInput(
                regression_signal_id=signal.id,
                comparison_id=signal.comparison_id,
                deduplication_key=signal.deduplication_key,
            ),
        ),
        target_paths=tuple(dict.fromkeys(normalized_paths)),
        priority=priority,
    )


HotspotLookup = Callable[[PerformanceComparison], str | None]
