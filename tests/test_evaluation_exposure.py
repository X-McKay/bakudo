from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator
from pydantic import ValidationError

from bakudo.evals.exposure import (
    EvaluationExposureRecord,
    ExposurePurpose,
    ExposureTaskPin,
    InMemoryExposureLedger,
    RestrictedPartition,
)
from bakudo.tasks.models import TaskPin

_CORPUS = {"sourceURI": "bundle://bakudo-benchmarks", "revision": "2026.08.18"}
_TASK_PIN = {
    "sourceURI": "bundle://bakudo-benchmarks",
    "corpusRevision": "2026.08.18",
    "name": "secret-regression",
    "version": 3,
    "bundleDigest": "sha256:bundle",
    "verifierDigest": "sha256:verifier",
    "partition": "validation",
}


def _record(**overrides) -> EvaluationExposureRecord:
    document = {
        "id": "exposure_00000000000000000000000000",
        "experimentId": "exp_01J0000000000000000000000",
        "partition": "validation",
        "purpose": "validation-selection",
        "recordedBy": "experiment-workflow",
        "authorizationRef": "change-123",
        "baselineRef": "debugger@17",
        "candidateRefs": ["debugger@18", "debugger@19"],
        "corpus": _CORPUS,
        "taskPins": [_TASK_PIN],
        "recordedAt": datetime(2026, 8, 18, tzinfo=UTC),
    }
    document.update(overrides)
    return EvaluationExposureRecord.model_validate(document)


def _schema() -> Draft202012Validator:
    path = Path(__file__).parents[1] / "schemas" / "evaluation-exposure.schema.json"
    return Draft202012Validator(json.loads(path.read_text()))


def test_validation_exposure_is_frozen_provenance_not_trial_evidence() -> None:
    record = _record()

    assert record.partition is RestrictedPartition.validation
    assert record.purpose is ExposurePurpose.validation_selection
    assert record.visibility == "restricted"
    assert record.task_pins[0].ref == "secret-regression@3"
    assert "reward" not in record.to_dict()
    assert "trial" not in record.to_dict()
    with pytest.raises(ValidationError):
        EvaluationExposureRecord.model_validate({**record.to_dict(), "trial": {}})
    with pytest.raises(ValidationError):
        record.task_pins[0].name = "mutated"  # type: ignore[misc]


def test_exposure_task_pin_freezes_the_trial_task_identity() -> None:
    task_pin = TaskPin(
        source_uri=_TASK_PIN["sourceURI"],
        corpus_revision=_TASK_PIN["corpusRevision"],
        name=_TASK_PIN["name"],
        version=_TASK_PIN["version"],
        bundle_digest=_TASK_PIN["bundleDigest"],
        verifier_digest=_TASK_PIN["verifierDigest"],
    )
    exposure_pin = ExposureTaskPin.from_task_pin(task_pin, partition=RestrictedPartition.validation)

    assert exposure_pin.to_dict() == _TASK_PIN


def test_holdout_requires_single_pre_registered_confirmation_candidate() -> None:
    record = _record(
        partition="holdout",
        purpose="holdout-confirmation",
        candidateRefs=["debugger@18"],
        taskPins=[{**_TASK_PIN, "partition": "holdout"}],
    )
    assert record.partition is RestrictedPartition.holdout

    with pytest.raises(ValidationError, match="exactly one"):
        _record(
            partition="holdout",
            purpose="holdout-confirmation",
            taskPins=[{**_TASK_PIN, "partition": "holdout"}],
        )
    with pytest.raises(ValidationError, match="requires purpose"):
        _record(
            partition="holdout",
            purpose="validation-selection",
            candidateRefs=["debugger@18"],
            taskPins=[{**_TASK_PIN, "partition": "holdout"}],
        )


@pytest.mark.parametrize(
    "overrides",
    [
        {"partition": "dev", "purpose": "validation-selection"},
        {"visibility": "public"},
        {"candidateRefs": ["debugger@17"]},
        {"taskPins": [{**_TASK_PIN, "corpusRevision": "other"}]},
        {"taskPins": [{**_TASK_PIN, "partition": "holdout"}]},
    ],
)
def test_restricted_exposure_rejects_public_or_incoherent_provenance(overrides) -> None:
    with pytest.raises(ValidationError):
        _record(**overrides)


def test_exposure_ledger_is_append_only_and_idempotent() -> None:
    ledger = InMemoryExposureLedger()
    first = _record()
    ledger.record_exposure(first)
    ledger.record_exposure(first)

    assert ledger.get_exposure(first.id) == first
    assert ledger.list_exposures(experiment_id=first.experiment_id) == [first]
    assert ledger.list_exposures(partition=RestrictedPartition.holdout) == []

    conflicting = _record(authorizationRef="change-124")
    with pytest.raises(ValueError, match="different evidence"):
        ledger.record_exposure(conflicting)


def test_json_schema_matches_restricted_exposure_contract() -> None:
    from bakudo.schema import SchemaValidationError, validate_evaluation_exposure

    schema = _schema()
    document = _record().to_dict()
    assert not list(schema.iter_errors(document))
    validate_evaluation_exposure(document)

    holdout_with_multiple_candidates = {
        **document,
        "partition": "holdout",
        "purpose": "holdout-confirmation",
    }
    assert list(schema.iter_errors(holdout_with_multiple_candidates))
    with pytest.raises(SchemaValidationError):
        validate_evaluation_exposure(holdout_with_multiple_candidates)
    public_document = {**document, "visibility": "public"}
    assert list(schema.iter_errors(public_document))
