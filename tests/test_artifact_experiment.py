from __future__ import annotations

from collections.abc import Callable

import pytest
from pydantic import ValidationError

from bakudo.experiments.artifact_subject import ArtifactMeasurementRequest
from bakudo.experiments.models import ExperimentSpec
from bakudo.experiments.runner import run_experiment
from bakudo.performance.models import (
    IntegrityResult,
    MeasurementRecord,
    MetricDirection,
    MetricEstimator,
    MetricSampleSet,
    MetricUnit,
    RecordStatus,
)
from bakudo.performance.pins import EnvironmentPin, RevisionPin, WorkloadPin
from bakudo.registry import InMemoryLedger
from bakudo.schema import SchemaValidationError, validate_experiment_spec

DIGEST = "sha256:" + "a" * 64
REPOSITORY = "example/repository"


def _revision(value: str) -> RevisionPin:
    return RevisionPin(
        repository=REPOSITORY,
        source_uri="https://example.invalid/repository.git",
        commit_sha=value * 40,
        tree_digest=DIGEST,
    )


BASELINE = _revision("1")
CANDIDATE = _revision("2")


def _workload() -> WorkloadPin:
    return WorkloadPin(
        source_uri="bundle://python-loop/1.0.0",
        source_kind="bundle",
        collection_revision="benchmarks-2026-08-17",
        name="python-loop",
        version="1.0.0",
        manifest_digest=DIGEST,
        bundle_digest=DIGEST,
    )


def _environment(*, environment_digest: str = DIGEST) -> EnvironmentPin:
    return EnvironmentPin(
        bakudo_version="3.0.0",
        abox_version="1.0.0",
        image_digest=DIGEST,
        profile="python-small",
        hardware_class="test",
        architecture="arm64",
        cpu_count=2,
        memory_mb=512,
        os="linux",
        kernel="6.0",
        dependency_lock_digest=DIGEST,
        environment_digest=environment_digest,
    )


def _spec(*, direction: str = "lower", repetitions: int = 3) -> ExperimentSpec:
    return ExperimentSpec.model_validate(
        {
            "metadata": {"name": "artifact-latency"},
            "subject": {
                "kind": "software-artifact",
                "repository": REPOSITORY,
                "baseline": BASELINE.model_dump(by_alias=True, mode="json"),
                "candidates": [CANDIDATE.model_dump(by_alias=True, mode="json")],
                "workloadRef": {
                    "name": "python-loop",
                    "version": "1.0.0",
                    "source": "bundle",
                },
            },
            "repetitions": repetitions,
            "metrics": {
                "primary": "latency_seconds",
                "directions": {"latency_seconds": direction},
            },
            "decision": {"bootstrapResamples": 100},
        }
    )


def _record(
    request: ArtifactMeasurementRequest,
    summary: float,
    *,
    valid: bool = True,
    environment: EnvironmentPin | None = None,
) -> MeasurementRecord:
    samples = MetricSampleSet(
        metric_name="latency_seconds",
        unit=MetricUnit.seconds,
        direction=MetricDirection.lower_is_better,
        estimator=MetricEstimator.median,
        samples=(summary,) if valid else (),
        summary=summary if valid else None,
        valid=valid,
        invalid_reasons=() if valid else ("timer overflow",),
    )
    return MeasurementRecord(
        workload=_workload(),
        revision=request.revision,
        environment=environment or _environment(),
        plan_digest=DIGEST,
        metrics=(samples,),
        status=RecordStatus.completed if valid else RecordStatus.inconclusive,
        integrity=IntegrityResult(),
    )


def _observer(
    factory: Callable[[ArtifactMeasurementRequest], MeasurementRecord],
) -> Callable[[ArtifactMeasurementRequest], MeasurementRecord]:
    return factory


def test_artifact_experiment_uses_persisted_measurement_ids_and_normalizes_direction() -> None:
    ledger = InMemoryLedger()

    def measure(request: ArtifactMeasurementRequest) -> MeasurementRecord:
        baseline = 10.0 if request.arm == "baseline" else 7.0
        summary = baseline + request.repetition
        return _record(request, summary)

    result = run_experiment(_spec(), ledger=ledger, artifact_measure=_observer(measure))

    candidate = result["comparison"]["candidate-1"]
    assert candidate["primary"]["direction"] == "lower"
    assert candidate["primary"]["meanDelta"] == pytest.approx(3.0)
    assert candidate["primary"]["verdict"] == "candidate"
    assert candidate["eligibleForPromotion"] is True
    assert ledger.list_trials(result["experimentId"]) == []
    assert len(result["measurementRecords"]) == 6
    assert {item["kind"] for item in result["observationRecords"]} == {
        "measurement-record"
    }
    assert all(item["id"].startswith("measurement_") for item in result["observationRecords"])
    stored = ledger.get_experiment(result["experimentId"])
    assert stored is not None
    assert stored["subject_kind"] == "software-artifact"
    assert stored["result"] == result


def test_artifact_invalid_measurement_is_contagious() -> None:
    ledger = InMemoryLedger()

    def measure(request: ArtifactMeasurementRequest) -> MeasurementRecord:
        if request.arm == "candidate-1" and request.repetition == 1:
            return _record(request, 0.0, valid=False)
        return _record(request, 10.0 if request.arm == "baseline" else 7.0)

    result = run_experiment(_spec(), ledger=ledger, artifact_measure=measure)
    primary = result["comparison"]["candidate-1"]["primary"]

    assert primary["valid"] is False
    assert primary["verdict"] == "inconclusive"
    assert any("timer overflow" in reason for reason in primary["invalidReasons"])
    assert result["comparison"]["candidate-1"]["eligibleForPromotion"] is False


def test_artifact_incompatible_environment_is_invalid() -> None:
    ledger = InMemoryLedger()
    different_digest = "sha256:" + "b" * 64

    def measure(request: ArtifactMeasurementRequest) -> MeasurementRecord:
        environment = (
            _environment(environment_digest=different_digest)
            if request.arm == "candidate-1"
            else _environment()
        )
        return _record(request, 10.0 if request.arm == "baseline" else 7.0, environment=environment)

    result = run_experiment(
        _spec(repetitions=1), ledger=ledger, artifact_measure=measure
    )
    primary = result["comparison"]["candidate-1"]["primary"]

    assert primary["valid"] is False
    assert any("environment.environment_digest" in reason for reason in primary["invalidReasons"])


def test_artifact_subject_requires_pin_objects_and_performance_metrics() -> None:
    document = _spec(repetitions=1).to_dict()
    validate_experiment_spec(document)

    invalid_metric = {**document, "metrics": {"primary": "task_success"}}
    with pytest.raises(ValidationError, match="task rewards"):
        ExperimentSpec.model_validate(invalid_metric)
    with pytest.raises(SchemaValidationError):
        validate_experiment_spec(invalid_metric)

    mixed_subject = {
        **document,
        "subject": {**document["subject"], "candidates": ["revision@2"]},
    }
    with pytest.raises(ValidationError):
        ExperimentSpec.model_validate(mixed_subject)
    with pytest.raises(SchemaValidationError):
        validate_experiment_spec(mixed_subject)


def test_artifact_measurement_id_must_already_be_persisted() -> None:
    with pytest.raises(ValueError, match="was not persisted"):
        run_experiment(
            _spec(repetitions=1),
            ledger=InMemoryLedger(),
            artifact_measure=lambda _request: "measurement_00000000000000000000000000",
        )
