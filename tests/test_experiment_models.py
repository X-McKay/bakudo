"""ExperimentSpec model + JSON Schema parity (Task 8, mirrors
tests/test_task_models.py)."""

import pytest
from pydantic import ValidationError

from bakudo.experiments.models import DecisionPolicy, ExperimentSpec, TaskSelector

MINIMAL = {
    "apiVersion": "bakudo.ai/v1alpha1",
    "kind": "ExperimentSpec",
    "metadata": {"name": "baseline-vs-candidate"},
    "subject": {"kind": "agent-spec", "baseline": "add-feature@1"},
}


def test_minimal_experiment_parses_with_defaults():
    spec = ExperimentSpec.model_validate(MINIMAL)
    assert spec.metadata.name == "baseline-vs-candidate"
    assert spec.subject.candidates == []  # profile mode
    assert spec.subject.task_selector.partitions == ["dev", "validation"]
    assert spec.subject.task_selector.count == 20
    assert spec.repetitions == 1
    assert spec.subject.use_holdout is False
    assert spec.metrics.primary == "task_success"
    assert spec.hard_gates.safety_regressions == 0
    assert spec.decision.confidence == 0.95
    assert spec.decision.tie_zone == 0.10
    assert spec.decision.cost_tiebreak is True
    assert spec.decision.min_paired_observations == 5


@pytest.mark.parametrize("bad_count", [0, -1])
def test_task_selector_count_must_be_positive(bad_count):
    with pytest.raises(ValidationError):
        TaskSelector(count=bad_count)


def test_extra_fields_forbidden():
    bad = {**MINIMAL, "surprise": 1}
    with pytest.raises(ValidationError):
        ExperimentSpec.model_validate(bad)


def test_bad_subject_rejected():
    bad = {**MINIMAL, "subject": {"kind": "not-agent-spec", "baseline": "a@1"}}
    with pytest.raises(ValidationError):
        ExperimentSpec.model_validate(bad)


def test_camelcase_aliases_round_trip():
    doc = {
        **MINIMAL,
        "subject": {
            "kind": "agent-spec",
            "baseline": "add-feature@1",
            "candidates": ["add-feature@2"],
            "useHoldout": True,
        },
        "hardGates": {"safetyRegressions": 1, "integrityViolations": 2},
        "decision": {
            "confidence": 0.9,
            "tieZone": 0.05,
            "costTiebreak": False,
            "minPairedObservations": 8,
        },
    }
    spec = ExperimentSpec.model_validate(doc)
    assert spec.subject.use_holdout is True
    assert spec.hard_gates.safety_regressions == 1
    assert spec.hard_gates.integrity_violations == 2
    assert spec.decision.tie_zone == 0.05
    assert spec.decision.cost_tiebreak is False
    assert spec.decision.min_paired_observations == 8
    assert spec.to_dict()["subject"]["useHoldout"] is True
    assert spec.to_dict()["hardGates"]["safetyRegressions"] == 1
    assert spec.to_dict()["decision"]["minPairedObservations"] == 8


def test_one_paired_observation_cannot_be_configured_as_promotion_evidence():
    with pytest.raises(ValidationError):
        DecisionPolicy(minPairedObservations=1)


def test_json_schema_accepts_minimal():
    from bakudo.schema import validate_experiment_spec

    validate_experiment_spec(MINIMAL)  # must not raise


def test_json_schema_rejects_bad_subject():
    from bakudo.schema import SchemaValidationError, validate_experiment_spec

    bad = {**MINIMAL, "subject": {"kind": "not-agent-spec", "baseline": "a@1"}}
    with pytest.raises(SchemaValidationError):
        validate_experiment_spec(bad)


def test_json_schema_rejects_one_paired_observation_minimum():
    from bakudo.schema import SchemaValidationError, validate_experiment_spec

    with pytest.raises(SchemaValidationError):
        validate_experiment_spec({**MINIMAL, "decision": {"minPairedObservations": 1}})
