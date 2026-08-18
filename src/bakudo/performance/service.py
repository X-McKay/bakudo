"""Plain orchestration for trusted performance measurements.

The service owns ordering and record construction while execution, storage,
statistics, and telemetry remain replaceable ports.  Both synchronous callers
and Temporal activities use this module so they cannot drift semantically.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Protocol

from ..ids import new_measurement_id
from ..observability import (
    NOOP_SPAN_SINK,
    SpanAttribute,
    SpanName,
    SpanSink,
    phase_span,
)
from .comparison import compare_measurements
from .compatibility import CompatibilityPolicy
from .measurement import (
    ComparisonSide,
    MeasurementPhase,
    build_comparison_schedule,
    metric_sample_sets_from_invocations,
    validate_warmups,
)
from .models import (
    FailureReason,
    IntegrityResult,
    InvocationOutcome,
    InvocationPhase,
    MeasurementPlan,
    MeasurementRecord,
    PerformanceComparison,
    RecordStatus,
    canonical_digest,
)
from .pins import EnvironmentPin, RevisionPin
from .source import LoadedWorkload


class WorkloadInvoker(Protocol):
    """Execute exactly one isolated workload invocation."""

    def invoke(
        self,
        workload: LoadedWorkload,
        revision: RevisionPin,
        environment: EnvironmentPin,
        *,
        phase: InvocationPhase,
        ordinal: int,
    ) -> InvocationOutcome: ...


class PerformanceLedger(Protocol):
    """Small persistence port used by the orchestration service."""

    def record_measurement(self, record: MeasurementRecord) -> None: ...

    def record_performance_comparison(self, comparison: PerformanceComparison) -> None: ...


@dataclass(frozen=True)
class ComparisonRun:
    """The two independent records and their derived comparison."""

    baseline: MeasurementRecord
    candidate: MeasurementRecord
    comparison: PerformanceComparison


class PerformanceServiceError(ValueError):
    """The requested workload/revision binding is internally inconsistent."""


def _validate_binding(workload: LoadedWorkload, revision: RevisionPin) -> None:
    if workload.pin.name != workload.spec.metadata.name:
        raise PerformanceServiceError("workload pin name does not match its manifest")
    if workload.pin.version != workload.spec.metadata.version:
        raise PerformanceServiceError("workload pin version does not match its manifest")
    if workload.pin.manifest_digest != canonical_digest(workload.spec):
        raise PerformanceServiceError("workload manifest no longer matches its immutable pin")
    if revision.repository != workload.spec.subject.repo:
        raise PerformanceServiceError(
            f"workload subject {workload.spec.subject.repo!r} cannot measure "
            f"repository {revision.repository!r}"
        )


def _environment_mismatches(
    workload: LoadedWorkload, environment: EnvironmentPin
) -> tuple[str, ...]:
    declared = workload.spec.environment
    mismatches: list[str] = []
    if declared.profile != environment.profile:
        mismatches.append(
            f"environment profile {environment.profile!r} does not match "
            f"workload profile {declared.profile!r}"
        )
    if declared.cpu_count is not None and declared.cpu_count != environment.cpu_count:
        mismatches.append(
            f"environment cpuCount {environment.cpu_count} does not match "
            f"workload cpuCount {declared.cpu_count}"
        )
    if declared.memory_mb is not None and declared.memory_mb != environment.memory_mb:
        mismatches.append(
            f"environment memoryMb {environment.memory_mb} does not match "
            f"workload memoryMb {declared.memory_mb}"
        )
    return tuple(mismatches)


def _terminal_state(
    plan: MeasurementPlan,
    warmups: Sequence[InvocationOutcome],
    invocations: Sequence[InvocationOutcome],
    metrics_valid: bool,
    integrity: IntegrityResult,
) -> tuple[RecordStatus, FailureReason | None]:
    outcomes = (*warmups, *invocations)
    if any(outcome.status is RecordStatus.cancelled for outcome in outcomes):
        return RecordStatus.cancelled, FailureReason.cancelled
    if any(outcome.status is RecordStatus.timed_out for outcome in outcomes):
        return RecordStatus.timed_out, FailureReason.timeout
    if any(outcome.status is RecordStatus.failed for outcome in outcomes):
        reason = next(
            (
                outcome.failure_reason
                for outcome in outcomes
                if outcome.status is RecordStatus.failed
                and outcome.failure_reason is not None
            ),
            FailureReason.infrastructure,
        )
        return RecordStatus.failed, reason
    if not integrity.valid:
        return RecordStatus.inconclusive, None
    if validate_warmups(plan, warmups) or not metrics_valid:
        return RecordStatus.inconclusive, None
    return RecordStatus.completed, None


class PerformanceMeasurementService:
    """Orchestrate uninstrumented measurement and paired comparison."""

    def __init__(
        self,
        invoker: WorkloadInvoker,
        *,
        ledger: PerformanceLedger | None = None,
        span_sink: SpanSink = NOOP_SPAN_SINK,
        clock: Callable[[], datetime] | None = None,
        measurement_id_factory: Callable[[], str] = new_measurement_id,
    ) -> None:
        self._invoker = invoker
        self._ledger = ledger
        self._span_sink = span_sink
        self._clock = clock or (lambda: datetime.now(UTC))
        self._measurement_id_factory = measurement_id_factory

    @staticmethod
    def _phase(value: MeasurementPhase) -> InvocationPhase:
        return (
            InvocationPhase.warmup
            if value is MeasurementPhase.warmup
            else InvocationPhase.measured
        )

    def _invoke(
        self,
        workload: LoadedWorkload,
        revision: RevisionPin,
        environment: EnvironmentPin,
        *,
        phase: InvocationPhase,
        ordinal: int,
    ) -> InvocationOutcome:
        try:
            return self._invoker.invoke(
                workload,
                revision,
                environment,
                phase=phase,
                ordinal=ordinal,
            )
        except asyncio.CancelledError:
            raise
        except TimeoutError:
            return InvocationOutcome(
                ordinal=ordinal,
                phase=phase,
                status=RecordStatus.timed_out,
                failure_reason=FailureReason.timeout,
            )
        except Exception:  # noqa: BLE001 - adapter failures become typed evidence
            # Deliberately no exception text: arbitrary host exceptions can
            # carry DSNs or host paths, and records are durable evidence.
            # Trusted runners persist their own bounded, guest-derived
            # failureDetail on the outcomes they return instead of raising.
            return InvocationOutcome(
                ordinal=ordinal,
                phase=phase,
                status=RecordStatus.failed,
                failure_reason=FailureReason.adapter,
            )

    def _record(
        self,
        workload: LoadedWorkload,
        revision: RevisionPin,
        environment: EnvironmentPin,
        *,
        warmups: Sequence[InvocationOutcome],
        invocations: Sequence[InvocationOutcome],
        integrity: IntegrityResult,
        record_id: str | None = None,
        started_at: datetime | None = None,
    ) -> MeasurementRecord:
        plan = workload.spec.measurement
        metrics = metric_sample_sets_from_invocations(plan, invocations)
        metrics_valid = bool(metrics) and all(item.valid for item in metrics)
        status, failure_reason = _terminal_state(
            plan, warmups, invocations, metrics_valid, integrity
        )
        completed_at = self._clock()
        record = MeasurementRecord(
            id=record_id or self._measurement_id_factory(),
            created_at=started_at or completed_at,
            started_at=started_at,
            completed_at=completed_at,
            workload=workload.pin,
            revision=revision,
            environment=environment,
            plan_digest=canonical_digest(plan),
            warmups=tuple(warmups),
            invocations=tuple(invocations),
            metrics=metrics,
            status=status,
            integrity=integrity,
            exit_code=next(
                (
                    outcome.exit_code
                    for outcome in reversed((*warmups, *invocations))
                    if outcome.exit_code not in {None, 0}
                ),
                0 if status is RecordStatus.completed else None,
            ),
            failure_reason=failure_reason,
        )
        self._persist_measurement(record)
        return record

    def _persist_measurement(self, record: MeasurementRecord) -> None:
        if self._ledger is None:
            return
        with phase_span(
            SpanName.LEDGER_PERSIST,
            sink=self._span_sink,
            attributes={SpanAttribute.MEASUREMENT_ID: record.id},
        ):
            self._ledger.record_measurement(record)

    def measure(
        self,
        workload: LoadedWorkload,
        revision: RevisionPin,
        environment: EnvironmentPin,
        *,
        integrity: IntegrityResult | None = None,
        record_id: str | None = None,
    ) -> MeasurementRecord:
        """Measure one revision in fresh invocations and persist the record."""

        _validate_binding(workload, revision)
        mismatches = _environment_mismatches(workload, environment)
        started_at = self._clock()
        if mismatches:
            record = MeasurementRecord(
                id=record_id or self._measurement_id_factory(),
                created_at=started_at,
                started_at=started_at,
                completed_at=self._clock(),
                workload=workload.pin,
                revision=revision,
                environment=environment,
                plan_digest=canonical_digest(workload.spec.measurement),
                status=RecordStatus.incompatible_environment,
                failure_reason=FailureReason.incompatible_pins,
                integrity=IntegrityResult(
                    valid=False,
                    violations=mismatches,
                ),
            )
            self._persist_measurement(record)
            return record

        warmups: list[InvocationOutcome] = []
        invocations: list[InvocationOutcome] = []
        with phase_span(
            SpanName.PERFORMANCE_MEASURE,
            sink=self._span_sink,
            attributes={
                SpanAttribute.WORKLOAD_NAME: workload.spec.metadata.name,
                SpanAttribute.WORKLOAD_VERSION: workload.spec.metadata.version,
            },
        ):
            for ordinal in range(workload.spec.measurement.warmups):
                warmups.append(
                    self._invoke(
                        workload,
                        revision,
                        environment,
                        phase=InvocationPhase.warmup,
                        ordinal=ordinal,
                    )
                )
            for ordinal in range(workload.spec.measurement.repetitions):
                invocations.append(
                    self._invoke(
                        workload,
                        revision,
                        environment,
                        phase=InvocationPhase.measured,
                        ordinal=ordinal,
                    )
                )
        return self._record(
            workload,
            revision,
            environment,
            warmups=warmups,
            invocations=invocations,
            integrity=integrity or IntegrityResult(),
            record_id=record_id,
            started_at=started_at,
        )

    def compare(
        self,
        workload: LoadedWorkload,
        baseline_revision: RevisionPin,
        candidate_revision: RevisionPin,
        baseline_environment: EnvironmentPin,
        candidate_environment: EnvironmentPin,
        *,
        seed: int,
        primary_metric: str | None = None,
        protected_metrics: Sequence[str] = (),
        confidence: float = 0.95,
        bootstrap_resamples: int = 10_000,
        integrity: IntegrityResult | None = None,
        compatibility_policy: CompatibilityPolicy | None = None,
        baseline_record_id: str | None = None,
        candidate_record_id: str | None = None,
        comparison_id: str | None = None,
    ) -> ComparisonRun:
        """Interleave fresh baseline/candidate runs, analyze, and persist them."""

        _validate_binding(workload, baseline_revision)
        _validate_binding(workload, candidate_revision)
        for environment in (baseline_environment, candidate_environment):
            mismatches = _environment_mismatches(workload, environment)
            if mismatches:
                raise PerformanceServiceError("; ".join(mismatches))

        plan = workload.spec.measurement
        outcomes: dict[
            ComparisonSide, dict[InvocationPhase, list[InvocationOutcome]]
        ] = {
            side: {InvocationPhase.warmup: [], InvocationPhase.measured: []}
            for side in ComparisonSide
        }
        revisions = {
            ComparisonSide.baseline: baseline_revision,
            ComparisonSide.candidate: candidate_revision,
        }
        environments = {
            ComparisonSide.baseline: baseline_environment,
            ComparisonSide.candidate: candidate_environment,
        }
        started_at = self._clock()
        with phase_span(
            SpanName.PERFORMANCE_MEASURE,
            sink=self._span_sink,
            attributes={
                SpanAttribute.WORKLOAD_NAME: workload.spec.metadata.name,
                SpanAttribute.WORKLOAD_VERSION: workload.spec.metadata.version,
            },
        ):
            for scheduled in build_comparison_schedule(plan, seed=seed):
                phase = self._phase(scheduled.phase)
                outcomes[scheduled.side][phase].append(
                    self._invoke(
                        workload,
                        revisions[scheduled.side],
                        environments[scheduled.side],
                        phase=phase,
                        ordinal=scheduled.pair_index,
                    )
                )

        effective_integrity = integrity or IntegrityResult()
        baseline = self._record(
            workload,
            baseline_revision,
            baseline_environment,
            warmups=outcomes[ComparisonSide.baseline][InvocationPhase.warmup],
            invocations=outcomes[ComparisonSide.baseline][InvocationPhase.measured],
            integrity=effective_integrity,
            record_id=baseline_record_id,
            started_at=started_at,
        )
        candidate = self._record(
            workload,
            candidate_revision,
            candidate_environment,
            warmups=outcomes[ComparisonSide.candidate][InvocationPhase.warmup],
            invocations=outcomes[ComparisonSide.candidate][InvocationPhase.measured],
            integrity=effective_integrity,
            record_id=candidate_record_id,
            started_at=started_at,
        )
        selected_primary = primary_metric or plan.metrics[0].name
        with phase_span(
            SpanName.STATISTICS_ANALYZE,
            sink=self._span_sink,
            attributes={
                SpanAttribute.METRIC_NAME: selected_primary,
                SpanAttribute.SAMPLE_COUNT: plan.repetitions,
            },
        ):
            comparison = compare_measurements(
                baseline,
                candidate,
                plan,
                primary_metric=selected_primary,
                protected_metrics=protected_metrics,
                confidence=confidence,
                bootstrap_resamples=bootstrap_resamples,
                analysis_seed=seed,
                compatibility_policy=compatibility_policy,
                required_integrity=effective_integrity,
                comparison_id=comparison_id,
            )
        if self._ledger is not None:
            with phase_span(
                SpanName.LEDGER_PERSIST,
                sink=self._span_sink,
                attributes={SpanAttribute.COMPARISON_ID: comparison.id},
            ):
                self._ledger.record_performance_comparison(comparison)
        return ComparisonRun(
            baseline=baseline,
            candidate=candidate,
            comparison=comparison,
        )
