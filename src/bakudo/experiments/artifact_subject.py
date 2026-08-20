"""Software-artifact experiment binding over persisted measurement records."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from ..performance.compatibility import compare_measurement_pins
from ..performance.models import MeasurementRecord, RecordStatus, RevisionPin, WorkloadRef
from .design import trial_seed
from .models import (
    ExperimentObservation,
    ExperimentSpec,
    MeasurementRecordEvidence,
    ObservationMetric,
    SoftwareArtifactSubject,
)
from .subjects import ObservationBatch


@dataclass(frozen=True)
class ArtifactMeasurementRequest:
    """One paired measurement cell requested by an artifact experiment."""

    experiment_id: str
    repository: str
    workload: WorkloadRef
    revision: RevisionPin
    arm: str
    repetition: int
    seed: int


ArtifactMeasurementObserver = Callable[[ArtifactMeasurementRequest], MeasurementRecord | str]


@dataclass(frozen=True)
class ArtifactObservationContext:
    records: tuple[tuple[str, int, MeasurementRecord], ...]


class ArtifactSubjectBinding:
    """Measure immutable revisions and emit ID-only observation envelopes."""

    def __init__(
        self,
        spec: ExperimentSpec,
        *,
        ledger: Any,
        measure: ArtifactMeasurementObserver,
    ) -> None:
        if not isinstance(spec.subject, SoftwareArtifactSubject):
            raise TypeError("ArtifactSubjectBinding requires a software-artifact subject")
        self.spec = spec
        self.subject = spec.subject
        self.ledger = ledger
        self.measure = measure

    @property
    def subject_kind(self) -> str:
        return self.subject.kind

    @property
    def baseline_arm(self) -> str:
        return "baseline"

    @property
    def candidate_arms(self) -> tuple[str, ...]:
        return tuple(f"candidate-{index}" for index in range(1, len(self.subject.candidates) + 1))

    @property
    def profile(self) -> bool:
        return False

    @property
    def invalid_contagious(self) -> bool:
        return True

    def _arms(self) -> tuple[tuple[str, RevisionPin], ...]:
        return (
            (self.baseline_arm, self.subject.baseline),
            *tuple(zip(self.candidate_arms, self.subject.candidates, strict=True)),
        )

    def _persisted_record(self, request: ArtifactMeasurementRequest) -> MeasurementRecord:
        returned = self.measure(request)
        if isinstance(returned, MeasurementRecord):
            self.ledger.record_measurement(returned)
            measurement_id = returned.id
        elif isinstance(returned, str):
            measurement_id = returned
        else:
            raise TypeError("artifact measurement observer must return MeasurementRecord or ID")
        record = self.ledger.get_measurement(measurement_id)
        if record is None:
            raise ValueError(
                f"artifact measurement {measurement_id!r} was not persisted before observation"
            )
        if isinstance(returned, MeasurementRecord) and record != returned:
            raise ValueError(f"persisted measurement {measurement_id!r} does not match callback")
        return record

    def _record_issues(
        self, record: MeasurementRecord, requested_revision: RevisionPin
    ) -> tuple[str, ...]:
        issues: list[str] = []
        if record.revision != requested_revision:
            issues.append("measurement revision does not match the requested artifact revision")
        if (
            record.workload.name != self.subject.workload_ref.name
            or record.workload.version != self.subject.workload_ref.version
        ):
            issues.append("measurement workload does not match subject.workloadRef")
        if record.status is not RecordStatus.completed:
            issues.append(f"measurement status is {record.status.value}")
        if not record.integrity.valid:
            issues.extend(f"integrity: {reason}" for reason in record.integrity.violations)
        return tuple(issues)

    def _observation(
        self,
        experiment_id: str,
        arm: str,
        repetition: int,
        requested_revision: RevisionPin,
        record: MeasurementRecord,
    ) -> ExperimentObservation:
        record_metrics = {metric.metric_name: metric for metric in record.metrics}
        global_issues = self._record_issues(record, requested_revision)
        values: list[ObservationMetric] = []
        degraded = list(global_issues)
        for name in (self.spec.metrics.primary, *self.spec.metrics.secondary):
            sample = record_metrics.get(name)
            issues = list(global_issues)
            if sample is None:
                issues.append(f"metric {name!r} is missing")
                direction = self.spec.metrics.direction_for(name)
                summary = None
            else:
                direction = sample.direction
                summary = sample.summary
                if not sample.valid or summary is None:
                    issues.extend(sample.invalid_reasons or (f"metric {name!r} is invalid",))
                declared = self.spec.metrics.directions.get(name)
                if declared is not None and declared is not direction:
                    issues.append(f"metric {name!r} direction disagrees with the experiment spec")
            if issues:
                degraded.extend(issue for issue in issues if issue not in degraded)
                values.append(
                    ObservationMetric(
                        name=name,
                        value=summary,
                        direction=direction,
                        valid=False,
                        invalid_reasons=tuple(dict.fromkeys(issues)),
                    )
                )
            else:
                values.append(
                    ObservationMetric(
                        name=name,
                        value=summary,
                        direction=direction,
                        valid=True,
                    )
                )
        return ExperimentObservation(
            experiment_id=experiment_id,
            subject_kind="software-artifact",
            arm=arm,
            pair_key=f"measurement-pair-{repetition}",
            repetition=repetition,
            metrics=tuple(values),
            integrity_valid=not global_issues,
            degraded=bool(degraded),
            degradation_reasons=tuple(degraded),
            evidence=MeasurementRecordEvidence(measurement_id=record.id),
        )

    @staticmethod
    def _invalidate(
        observation: ExperimentObservation, reasons: tuple[str, ...]
    ) -> ExperimentObservation:
        if not reasons:
            return observation
        metrics = tuple(
            metric.model_copy(
                update={
                    "valid": False,
                    "invalid_reasons": tuple(dict.fromkeys((*metric.invalid_reasons, *reasons))),
                }
            )
            for metric in observation.metrics
        )
        return observation.model_copy(
            update={
                "metrics": metrics,
                "integrity_valid": False,
                "degraded": True,
                "degradation_reasons": tuple(
                    dict.fromkeys((*observation.degradation_reasons, *reasons))
                ),
            }
        )

    def collect(self, experiment_id: str) -> ObservationBatch:
        records: list[tuple[str, int, MeasurementRecord]] = []
        observations: list[ExperimentObservation] = []
        for repetition in range(self.spec.repetitions):
            seed = trial_seed(experiment_id, self.subject.workload_ref.ref, repetition)
            for arm, revision in self._arms():
                request = ArtifactMeasurementRequest(
                    experiment_id=experiment_id,
                    repository=self.subject.repository,
                    workload=self.subject.workload_ref,
                    revision=revision,
                    arm=arm,
                    repetition=repetition,
                    seed=seed,
                )
                record = self._persisted_record(request)
                records.append((arm, repetition, record))
                observations.append(
                    self._observation(experiment_id, arm, repetition, revision, record)
                )

        by_cell = {(arm, repetition): record for arm, repetition, record in records}
        observations_by_cell = {
            (observation.arm, observation.repetition): index
            for index, observation in enumerate(observations)
        }
        for repetition in range(self.spec.repetitions):
            baseline = by_cell[(self.baseline_arm, repetition)]
            for arm in self.candidate_arms:
                candidate = by_cell[(arm, repetition)]
                report = compare_measurement_pins(baseline, candidate)
                if report.mismatches or report.allowed_differences:
                    reasons = tuple((*report.mismatches, *report.allowed_differences))
                    index = observations_by_cell[(arm, repetition)]
                    observations[index] = self._invalidate(observations[index], reasons)

        return ObservationBatch(tuple(observations), ArtifactObservationContext(tuple(records)))

    @staticmethod
    def _context(batch: ObservationBatch) -> ArtifactObservationContext:
        if not isinstance(batch.context, ArtifactObservationContext):
            raise TypeError("artifact observation batch has the wrong context")
        return batch.context

    def hard_gate_counts(self, batch: ObservationBatch, arm: str) -> tuple[int, int]:
        integrity = sum(
            1
            for observation in batch.observations
            if observation.arm == arm and not observation.integrity_valid
        )
        return 0, integrity

    def cost_delta(self, batch: ObservationBatch, arm: str) -> float | None:
        return None

    def base_result(self, experiment_id: str, batch: ObservationBatch) -> dict[str, Any]:
        context = self._context(batch)
        records = [
            {
                "arm": arm,
                "repetition": repetition,
                "measurementId": record.id,
                "workloadPin": record.workload.model_dump(by_alias=True, mode="json"),
                "revisionPin": record.revision.model_dump(by_alias=True, mode="json"),
                "environmentPin": record.environment.model_dump(by_alias=True, mode="json"),
                "planDigest": record.plan_digest,
                "status": record.status.value,
                "integrity": record.integrity.model_dump(by_alias=True, mode="json"),
            }
            for arm, repetition, record in context.records
        ]
        return {
            "experimentId": experiment_id,
            "subjectKind": self.subject_kind,
            "subject": self.subject.model_dump(by_alias=True, mode="json"),
            "profile": False,
            "baseline": {
                "arm": self.baseline_arm,
                "revision": self.subject.baseline.model_dump(by_alias=True, mode="json"),
            },
            "candidates": [
                {
                    "arm": arm,
                    "revision": revision.model_dump(by_alias=True, mode="json"),
                }
                for arm, revision in zip(self.candidate_arms, self.subject.candidates, strict=True)
            ],
            "workloadRef": self.subject.workload_ref.to_dict(),
            "measurementRecords": records,
            "degradedMeasurements": sum(
                1 for observation in batch.observations if observation.degraded
            ),
            "observationRecords": [
                {
                    "arm": observation.arm,
                    "pairKey": observation.pair_key,
                    "repetition": observation.repetition,
                    "kind": "measurement-record",
                    "id": observation.evidence.measurement_id,
                }
                for observation in batch.observations
                if isinstance(observation.evidence, MeasurementRecordEvidence)
            ],
        }
