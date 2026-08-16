"""ExperimentSpec model + JSON Schema parity (Task 8, mirrors
tests/test_scenario_models.py)."""

import pytest
from pydantic import ValidationError

from bakudo.experiments.models import ExperimentSpec

MINIMAL = {
    "apiVersion": "bakudo.ai/v1alpha1",
    "kind": "ExperimentSpec",
    "metadata": {"name": "baseline-vs-candidate"},
    "subject": "agent-spec",
    "baseline": "add-feature@1",
}


def test_minimal_experiment_parses_with_defaults():
    spec = ExperimentSpec.model_validate(MINIMAL)
    assert spec.metadata.name == "baseline-vs-candidate"
    assert spec.candidates == []  # profile mode
    assert spec.scenario_selector.partitions == ["dev", "validation"]
    assert spec.scenario_selector.count == 20
    assert spec.repetitions == 1
    assert spec.use_holdout is False
    assert spec.metrics.primary == "task_success"
    assert spec.hard_gates.safety_regressions == 0
    assert spec.decision.confidence == 0.95
    assert spec.decision.tie_zone == 0.10
    assert spec.decision.cost_tiebreak is True


def test_extra_fields_forbidden():
    bad = {**MINIMAL, "surprise": 1}
    with pytest.raises(ValidationError):
        ExperimentSpec.model_validate(bad)


def test_bad_subject_rejected():
    bad = {**MINIMAL, "subject": "not-agent-spec"}
    with pytest.raises(ValidationError):
        ExperimentSpec.model_validate(bad)


def test_camelcase_aliases_round_trip():
    doc = {
        **MINIMAL,
        "candidates": ["add-feature@2"],
        "useHoldout": True,
        "hardGates": {"safetyRegressions": 1, "hackFlags": 2},
        "decision": {"confidence": 0.9, "tieZone": 0.05, "costTiebreak": False},
    }
    spec = ExperimentSpec.model_validate(doc)
    assert spec.use_holdout is True
    assert spec.hard_gates.safety_regressions == 1
    assert spec.hard_gates.hack_flags == 2
    assert spec.decision.tie_zone == 0.05
    assert spec.decision.cost_tiebreak is False
    assert spec.to_dict()["useHoldout"] is True
    assert spec.to_dict()["hardGates"]["safetyRegressions"] == 1


def test_json_schema_accepts_minimal():
    from bakudo.schema import validate_experiment_spec

    validate_experiment_spec(MINIMAL)  # must not raise


def test_json_schema_rejects_bad_subject():
    from bakudo.schema import SchemaValidationError, validate_experiment_spec

    bad = {**MINIMAL, "subject": "not-agent-spec"}
    with pytest.raises(SchemaValidationError):
        validate_experiment_spec(bad)
