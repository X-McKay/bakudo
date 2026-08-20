from __future__ import annotations

import copy
import json
from datetime import UTC, datetime
from pathlib import Path

import pytest
import yaml
from pydantic import ValidationError

from bakudo.performance.models import (
    IntegrityResult,
    InvocationOutcome,
    InvocationPhase,
    MeasurementRecord,
    MetricDirection,
    MetricEstimator,
    MetricSampleSet,
    MetricUnit,
    RecordStatus,
    SourceKind,
    WorkloadRef,
    WorkloadSpec,
    canonical_digest,
    canonical_json_bytes,
)
from bakudo.performance.pins import EnvironmentPin, RevisionPin, WorkloadPin
from bakudo.schema import (
    SchemaValidationError,
    validate_performance_record,
    validate_workload_spec,
)

FIXTURES = Path(__file__).parent / "fixtures" / "performance"
DIGEST = "sha256:" + "0" * 64


def _document() -> dict:
    return yaml.safe_load((FIXTURES / "valid-workload.yaml").read_text())


def _pins() -> tuple[WorkloadPin, RevisionPin, EnvironmentPin]:
    workload = WorkloadPin(
        source_uri="file:///workloads",
        source_kind="directory",
        collection_revision="rev-1",
        name="python-loop",
        version="1.0.0",
        manifest_digest=DIGEST,
        bundle_digest=DIGEST,
    )
    revision = RevisionPin(
        repository="fixture-repo",
        source_uri="file:///repo",
        commit_sha="a" * 40,
        tree_digest=DIGEST,
    )
    environment = EnvironmentPin(
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
        environment_digest=DIGEST,
    )
    return workload, revision, environment


def _measurement_record() -> MeasurementRecord:
    workload, revision, environment = _pins()
    outcome = InvocationOutcome(
        ordinal=0,
        phase=InvocationPhase.measured,
        status=RecordStatus.completed,
        elapsed_seconds=1.0,
    )
    samples = MetricSampleSet(
        metric_name="latency_seconds",
        unit=MetricUnit.seconds,
        direction=MetricDirection.lower_is_better,
        estimator=MetricEstimator.median,
        samples=(1.0, 1.1),
        summary=1.05,
        dispersion=0.05,
        valid=True,
    )
    return MeasurementRecord(
        workload=workload,
        revision=revision,
        environment=environment,
        plan_digest=DIGEST,
        invocations=(outcome,),
        metrics=(samples,),
        status=RecordStatus.completed,
        integrity=IntegrityResult(),
        started_at=datetime(2026, 8, 17, tzinfo=UTC),
        completed_at=datetime(2026, 8, 17, 0, 0, 1, tzinfo=UTC),
    )


def test_valid_workload_has_schema_and_model_parity() -> None:
    document = _document()
    validate_workload_spec(document)
    spec = WorkloadSpec.model_validate(document)
    validate_workload_spec(spec.to_dict())
    assert spec.ref == "python-loop@1.0.0"
    assert spec.command.argv == ("python", "run.py", "data/input.json")


def test_workload_reference_uses_canonical_source_kinds() -> None:
    ref = WorkloadRef(name="python-loop", version="1.0.0", source=SourceKind.repository)
    assert ref.to_dict()["source"] == "repository"
    with pytest.raises(ValidationError):
        WorkloadRef(name="python-loop", version="1.0.0", source="repo")


@pytest.mark.parametrize("path", sorted((FIXTURES / "invalid-workloads").glob("*.yaml")))
def test_invalid_workload_fixtures_fail_schema_and_model(path: Path) -> None:
    document = yaml.safe_load(path.read_text())
    with pytest.raises(SchemaValidationError):
        validate_workload_spec(document)
    with pytest.raises(ValidationError):
        WorkloadSpec.model_validate(document)


def test_duplicate_metrics_fail_closed() -> None:
    document = _document()
    document["measurement"]["metrics"].append(copy.deepcopy(document["measurement"]["metrics"][0]))
    with pytest.raises(ValidationError, match="unique names"):
        WorkloadSpec.model_validate(document)


def test_canonical_serialization_and_digest_are_stable() -> None:
    spec = WorkloadSpec.model_validate(_document())
    first = canonical_json_bytes(spec)
    reparsed = WorkloadSpec.model_validate_json(first)
    assert canonical_json_bytes(reparsed) == first
    assert canonical_digest(reparsed) == canonical_digest(spec)
    assert list(json.loads(first)) == sorted(json.loads(first))


def test_samples_reject_non_finite_values() -> None:
    with pytest.raises(ValidationError, match="finite"):
        MetricSampleSet(
            metric_name="latency_seconds",
            unit="seconds",
            direction="lower",
            estimator="median",
            samples=(1.0, float("nan")),
            summary=1.0,
            valid=True,
        )


def test_record_requires_timezone_aware_timestamps() -> None:
    record = _measurement_record().to_dict()
    record["createdAt"] = "2026-08-17T12:00:00"
    with pytest.raises(ValidationError):
        MeasurementRecord.model_validate(record)
    with pytest.raises(SchemaValidationError):
        validate_performance_record(record)


def test_measurement_record_round_trip_and_schema_parity() -> None:
    record = _measurement_record()
    document = record.to_dict()
    validate_performance_record(document)
    assert MeasurementRecord.model_validate(document) == record
    assert record.id.startswith("measurement_")


def test_completed_record_cannot_contain_invalid_samples() -> None:
    workload, revision, environment = _pins()
    invalid = MetricSampleSet(
        metric_name="latency_seconds",
        unit="seconds",
        direction="lower",
        estimator="median",
        valid=False,
        invalid_reasons=("timed out",),
    )
    with pytest.raises(ValidationError, match="completed records"):
        MeasurementRecord(
            workload=workload,
            revision=revision,
            environment=environment,
            plan_digest=DIGEST,
            metrics=(invalid,),
            status="completed",
        )
