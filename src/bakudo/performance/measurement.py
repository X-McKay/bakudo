"""Pure scheduling and sample construction for performance measurements.

Real process execution belongs to an adapter (the first is the abox runner).
This module owns the deterministic comparison schedule and the narrow runner
port so orchestration can be tested without a clock, subprocess, or sandbox.
"""

from __future__ import annotations

import random
import re
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import Enum
from typing import Protocol

from ..ids import new_measurement_id
from .models import (
    FailureReason,
    IntegrityResult,
    InvocationOutcome,
    InvocationPhase,
    MeasurementPlan,
    MeasurementRecord,
    MetricDefinition,
    MetricSampleSet,
    MetricValue,
    RecordStatus,
)
from .pins import EnvironmentPin, RevisionPin, WorkloadPin
from .statistics import (
    StatisticalInputError,
    dispersion,
    estimate,
    required_samples,
)


class ComparisonSide(str, Enum):
    baseline = "baseline"
    candidate = "candidate"


class MeasurementPhase(str, Enum):
    warmup = "warmup"
    measured = "measured"


@dataclass(frozen=True)
class ScheduledInvocation:
    """One side placement in a deterministic paired measurement schedule."""

    ordinal: int
    phase: MeasurementPhase
    side: ComparisonSide
    pair_index: int


@dataclass(frozen=True)
class MeasurementRequest:
    """Everything a runner needs to create one immutable measurement record."""

    idempotency_key: str
    workload: WorkloadPin
    revision: RevisionPin
    environment: EnvironmentPin
    plan: MeasurementPlan
    plan_digest: str

    def __post_init__(self) -> None:
        if not self.idempotency_key.strip():
            raise ValueError("idempotency_key must not be empty")
        if re.fullmatch(r"sha256:[0-9a-f]{64}", self.plan_digest) is None:
            raise ValueError("plan_digest must be a sha256 digest")


class MeasurementRunner(Protocol):
    """Replaceable runner for one pinned, uninstrumented measurement."""

    def measure(self, request: MeasurementRequest) -> MeasurementRecord:
        """Execute or replay ``request`` and return an immutable record."""
        ...


def _schedule_name(plan: MeasurementPlan) -> str:
    value = getattr(plan.schedule, "value", plan.schedule)
    return str(value)


def _pair_placements(
    count: int,
    *,
    schedule: str,
    rng: random.Random,
) -> list[tuple[ComparisonSide, int]]:
    placements: list[tuple[ComparisonSide, int]] = []
    if schedule == "randomized-pairs":
        for pair_index in range(count):
            sides = [ComparisonSide.baseline, ComparisonSide.candidate]
            rng.shuffle(sides)
            placements.extend((side, pair_index) for side in sides)
        return placements

    if schedule == "abba":
        pair_index = 0
        while pair_index < count:
            if pair_index + 1 < count:
                placements.extend(
                    (
                        (ComparisonSide.baseline, pair_index),
                        (ComparisonSide.candidate, pair_index),
                        (ComparisonSide.candidate, pair_index + 1),
                        (ComparisonSide.baseline, pair_index + 1),
                    )
                )
                pair_index += 2
            else:
                placements.extend(
                    (
                        (ComparisonSide.baseline, pair_index),
                        (ComparisonSide.candidate, pair_index),
                    )
                )
                pair_index += 1
        return placements

    if schedule == "fixed":
        for pair_index in range(count):
            placements.extend(
                (
                    (ComparisonSide.baseline, pair_index),
                    (ComparisonSide.candidate, pair_index),
                )
            )
        return placements

    raise ValueError(f"unsupported measurement schedule: {schedule}")


def build_comparison_schedule(
    plan: MeasurementPlan,
    *,
    seed: int,
) -> tuple[ScheduledInvocation, ...]:
    """Build warmup-then-measured placements for both comparison sides.

    Randomized schedules use only a local ``random.Random(seed)`` instance.
    Pair indexes are local to each phase and link the baseline/candidate values
    used by paired analysis; warmups never consume a measured pair index.
    """

    rng = random.Random(seed)
    schedule = _schedule_name(plan)
    phases = (
        (MeasurementPhase.warmup, plan.warmups),
        (MeasurementPhase.measured, plan.repetitions),
    )
    invocations: list[ScheduledInvocation] = []
    for phase, count in phases:
        for side, pair_index in _pair_placements(count, schedule=schedule, rng=rng):
            invocations.append(
                ScheduledInvocation(
                    ordinal=len(invocations),
                    phase=phase,
                    side=side,
                    pair_index=pair_index,
                )
            )
    return tuple(invocations)


def _deduplicate_reasons(reasons: Sequence[str]) -> tuple[str, ...]:
    return tuple(dict.fromkeys(reason for reason in reasons if reason))


def build_metric_sample_set(
    definition: MetricDefinition,
    raw_samples: Sequence[object],
    *,
    expected_count: int,
    invalid_reasons: Sequence[str] = (),
    external_invalid_count: int = 0,
) -> MetricSampleSet:
    """Validate and summarize one metric without silently dropping bad data.

    Non-finite or non-numeric inputs cannot be represented by the persisted
    model, so they are counted and explained while the whole set is marked
    invalid.  An invalid set never receives a summary and therefore cannot be
    consumed by comparison logic as favorable evidence.
    """

    if expected_count < 1:
        raise ValueError("expected_count must be at least 1")
    if external_invalid_count < 0:
        raise ValueError("external_invalid_count must not be negative")

    values: list[float] = []
    reasons = list(invalid_reasons)
    invalid_count = external_invalid_count
    for index, raw_sample in enumerate(raw_samples):
        if isinstance(raw_sample, bool) or not isinstance(raw_sample, (int, float)):
            invalid_count += 1
            reasons.append(f"sample {index} is not numeric")
            continue
        sample = float(raw_sample)
        try:
            # This also catches NaN and infinities without importing a second
            # validity policy into this module.
            estimate((sample,), "mean")
        except StatisticalInputError:
            invalid_count += 1
            reasons.append(f"sample {index} is not finite")
            continue
        values.append(sample)

    supplied_count = len(raw_samples)
    if supplied_count != expected_count:
        # Runner-level failures frequently explain a missing emitted value.
        # Count the unexplained remainder instead of double-counting the same
        # failed invocation as both external and missing evidence.
        count_difference = abs(expected_count - supplied_count)
        invalid_count += max(0, count_difference - external_invalid_count)
        reasons.append(f"expected {expected_count} samples, received {supplied_count}")

    minimum = max(definition.minimum_samples, required_samples(definition.estimator))
    if len(values) < minimum:
        reasons.append(
            f"{definition.estimator.value} requires at least {minimum} valid samples, "
            f"received {len(values)}"
        )

    normalized_reasons = _deduplicate_reasons(reasons)
    valid = (
        not normalized_reasons
        and invalid_count == 0
        and supplied_count == expected_count
        and len(values) >= minimum
    )
    summary = estimate(values, definition.estimator) if valid else None
    spread = dispersion(values, definition.estimator) if valid else None
    return MetricSampleSet(
        metric_name=definition.name,
        unit=definition.unit,
        direction=definition.direction,
        estimator=definition.estimator,
        samples=tuple(values),
        invalid_sample_count=invalid_count,
        summary=summary,
        dispersion=spread,
        valid=valid,
        invalid_reasons=normalized_reasons,
    )


def validate_warmups(
    plan: MeasurementPlan,
    outcomes: Sequence[InvocationOutcome],
) -> tuple[str, ...]:
    """Validate warmups independently; their metrics never enter summaries."""

    reasons: list[str] = []
    if len(outcomes) != plan.warmups:
        reasons.append(f"expected {plan.warmups} warmups, received {len(outcomes)}")
    seen_ordinals: set[int] = set()
    for position, outcome in enumerate(outcomes):
        if outcome.phase is not InvocationPhase.warmup:
            reasons.append(f"outcome {outcome.ordinal} is not a warmup")
        if outcome.ordinal != position:
            reasons.append(
                f"warmup position {position} has ordinal {outcome.ordinal}; expected {position}"
            )
        if outcome.ordinal in seen_ordinals:
            reasons.append(f"duplicate warmup ordinal {outcome.ordinal}")
        seen_ordinals.add(outcome.ordinal)
        if outcome.status is not RecordStatus.completed:
            reasons.append(f"warmup {outcome.ordinal} ended with {outcome.status.value}")
    return _deduplicate_reasons(reasons)


def metric_sample_sets_from_invocations(
    plan: MeasurementPlan,
    outcomes: Sequence[InvocationOutcome],
) -> tuple[MetricSampleSet, ...]:
    """Build declared sample sets from trusted per-invocation metric values."""

    definitions = {definition.name: definition for definition in plan.metrics}
    reasons_by_metric: dict[str, list[str]] = {name: [] for name in definitions}
    samples_by_metric: dict[str, list[object]] = {name: [] for name in definitions}
    invalid_by_metric: dict[str, int] = {name: 0 for name in definitions}

    if len(outcomes) != plan.repetitions:
        count_reason = f"expected {plan.repetitions} invocations, received {len(outcomes)}"
        for reasons in reasons_by_metric.values():
            reasons.append(count_reason)

    seen_ordinals: set[int] = set()
    for position, outcome in enumerate(outcomes):
        if outcome.phase is not InvocationPhase.measured:
            for reasons in reasons_by_metric.values():
                reasons.append(f"outcome {outcome.ordinal} is not measured")
        if outcome.ordinal != position:
            for reasons in reasons_by_metric.values():
                reasons.append(
                    f"measured position {position} has ordinal {outcome.ordinal}; "
                    f"expected {position}"
                )
        if outcome.ordinal in seen_ordinals:
            for reasons in reasons_by_metric.values():
                reasons.append(f"duplicate measured ordinal {outcome.ordinal}")
        seen_ordinals.add(outcome.ordinal)

        emitted = {metric.name: metric for metric in outcome.metrics}
        undeclared = sorted(set(emitted) - set(definitions))
        if undeclared:
            raise ValueError(f"invocation emitted undeclared metrics: {', '.join(undeclared)}")

        for name, definition in definitions.items():
            value = emitted.get(name)
            if outcome.status is not RecordStatus.completed:
                invalid_by_metric[name] += 1
                reasons_by_metric[name].append(
                    f"invocation {outcome.ordinal} ended with {outcome.status.value}"
                )
                continue
            if value is None:
                invalid_by_metric[name] += 1
                reasons_by_metric[name].append(
                    f"invocation {outcome.ordinal} did not emit {name}"
                )
                continue
            if value.unit is not definition.unit:
                invalid_by_metric[name] += 1
                reasons_by_metric[name].append(
                    f"invocation {outcome.ordinal} emitted {name} in {value.unit.value}; "
                    f"expected {definition.unit.value}"
                )
                continue
            samples_by_metric[name].append(value.value)

    sample_sets: list[MetricSampleSet] = []
    for definition in plan.metrics:
        samples = samples_by_metric[definition.name]
        if not definition.required and not samples and not reasons_by_metric[definition.name]:
            continue
        sample_sets.append(
            build_metric_sample_set(
                definition,
                samples,
                expected_count=plan.repetitions,
                invalid_reasons=reasons_by_metric[definition.name],
                external_invalid_count=invalid_by_metric[definition.name],
            )
        )
    return tuple(sample_sets)


def _failure_status(reason: FailureReason) -> RecordStatus:
    if reason is FailureReason.timeout:
        return RecordStatus.timed_out
    if reason is FailureReason.cancelled:
        return RecordStatus.cancelled
    return RecordStatus.failed


@dataclass(frozen=True)
class SyntheticMeasurementScript:
    """Fixed samples and failures consumed by :class:`SyntheticMeasurementRunner`."""

    metric_samples: Mapping[str, Sequence[object]]
    warmup_failures: Mapping[int, FailureReason] = field(default_factory=dict)
    invocation_failures: Mapping[int, FailureReason] = field(default_factory=dict)
    terminal_status: RecordStatus | None = None
    failure_reason: FailureReason | None = None
    integrity: IntegrityResult = field(default_factory=IntegrityResult)
    exit_code: int | None = 0
    stdout: str = ""
    stderr: str = ""

    def __post_init__(self) -> None:
        if self.terminal_status not in {None, RecordStatus.completed, RecordStatus.inconclusive}:
            if self.failure_reason is None:
                raise ValueError("failed synthetic terminal statuses require a failure_reason")


class SyntheticMeasurementRunner:
    """Idempotent fake runner driven entirely by fixed scripts, never wall time."""

    def __init__(
        self,
        scripts: Mapping[str, SyntheticMeasurementScript | Exception],
        *,
        clock: Callable[[], datetime] | None = None,
        id_factory: Callable[[], str] = new_measurement_id,
    ) -> None:
        self._scripts = dict(scripts)
        self._clock = clock or (lambda: datetime.now(UTC))
        self._id_factory = id_factory
        self._records: dict[str, MeasurementRecord] = {}
        self._requests: dict[str, MeasurementRequest] = {}

    def measure(self, request: MeasurementRequest) -> MeasurementRecord:
        if request.idempotency_key in self._records:
            if self._requests[request.idempotency_key] != request:
                raise ValueError("idempotency key was reused with a different measurement request")
            return self._records[request.idempotency_key]
        try:
            script = self._scripts[request.idempotency_key]
        except KeyError as exc:
            raise KeyError(f"no synthetic script for {request.idempotency_key!r}") from exc
        if isinstance(script, Exception):
            raise script

        declared_names = {definition.name for definition in request.plan.metrics}
        undeclared = sorted(set(script.metric_samples) - declared_names)
        if undeclared:
            raise ValueError(f"script contains undeclared metrics: {', '.join(undeclared)}")

        warmups = tuple(
            InvocationOutcome(
                ordinal=index,
                phase=InvocationPhase.warmup,
                status=(
                    _failure_status(script.warmup_failures[index])
                    if index in script.warmup_failures
                    else RecordStatus.completed
                ),
                elapsed_seconds=0.0,
                exit_code=0 if index not in script.warmup_failures else None,
                failure_reason=script.warmup_failures.get(index),
            )
            for index in range(request.plan.warmups)
        )

        invocations: list[InvocationOutcome] = []
        for index in range(request.plan.repetitions):
            failure = script.invocation_failures.get(index)
            values: list[MetricValue] = []
            if failure is None:
                for definition in request.plan.metrics:
                    raw = script.metric_samples.get(definition.name, ())
                    if index >= len(raw):
                        continue
                    value = raw[index]
                    if isinstance(value, bool) or not isinstance(value, (int, float)):
                        continue
                    try:
                        values.append(
                            MetricValue(
                                name=definition.name,
                                unit=definition.unit,
                                value=float(value),
                            )
                        )
                    except ValueError:
                        # The sample builder records the invalid non-finite input
                        # and prevents it from becoming comparison evidence.
                        continue
            invocations.append(
                InvocationOutcome(
                    ordinal=index,
                    phase=InvocationPhase.measured,
                    status=_failure_status(failure) if failure else RecordStatus.completed,
                    elapsed_seconds=0.0,
                    exit_code=0 if failure is None else None,
                    metrics=tuple(values),
                    failure_reason=failure,
                )
            )

        failure_reasons = tuple(
            f"invocation {index} ended with {_failure_status(reason).value}"
            for index, reason in sorted(script.invocation_failures.items())
        )
        metric_sets = tuple(
            build_metric_sample_set(
                definition,
                script.metric_samples.get(definition.name, ()),
                expected_count=request.plan.repetitions,
                invalid_reasons=failure_reasons,
                external_invalid_count=len(script.invocation_failures),
            )
            for definition in request.plan.metrics
            if definition.required or definition.name in script.metric_samples
        )
        warmup_reasons = validate_warmups(request.plan, warmups)
        inferred_status = (
            RecordStatus.completed
            if not warmup_reasons
            and script.integrity.valid
            and metric_sets
            and all(sample_set.valid for sample_set in metric_sets)
            else RecordStatus.inconclusive
        )
        status = script.terminal_status or inferred_status
        now = self._clock()
        record = MeasurementRecord(
            id=self._id_factory(),
            created_at=now,
            started_at=now,
            completed_at=now,
            workload=request.workload,
            revision=request.revision,
            environment=request.environment,
            plan_digest=request.plan_digest,
            warmups=warmups,
            invocations=tuple(invocations),
            metrics=metric_sets,
            status=status,
            integrity=script.integrity,
            exit_code=script.exit_code,
            stdout=script.stdout,
            stderr=script.stderr,
            failure_reason=script.failure_reason,
        )
        self._requests[request.idempotency_key] = request
        self._records[request.idempotency_key] = record
        return record
