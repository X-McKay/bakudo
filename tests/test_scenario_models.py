import pytest
from pydantic import ValidationError

from bakudo.ids import new_experiment_id, new_trial_id
from bakudo.scenarios.models import ScenarioSpec

MINIMAL = {
    "apiVersion": "bakudo.ai/v1alpha1",
    "kind": "ScenarioSpec",
    "metadata": {
        "name": "sample-bug", "version": 1, "family": "debugging",
        "difficulty": "easy", "tags": ["python"], "partition": "dev",
        "canary": "bakudo-canary-TESTGUID",
        "provenance": {"createdBy": "human", "createdAt": "2026-08-15",
                       "sourceType": "hand-written", "eligibleForPromotion": True},
    },
    "mission": {"type": "qa", "title": "Fix the bug", "description": "There is a bug.",
                "acceptanceCriteria": ["tests pass"], "constraints": {"maxFilesChanged": 2}},
    "environment": {"profile": "python-glibc", "network": "none"},
    "budgets": {"wallSeconds": 600, "toolCalls": 30, "tokens": 20000},
    "hidden": {"failToPass": ["hidden/test_bug.py"], "passToPass": ["hidden/test_ok.py"],
               "testCommand": "pytest {files} -q", "wrongFixProbes": [],
               "expectedFiles": ["app.py"]},
    "expect": {"status": "completed", "changesPaths": ["app.py"], "maxChangedFiles": 2,
               "forbidsDeniedCommands": True, "testPathsImmutable": True},
}


def test_minimal_scenario_parses():
    spec = ScenarioSpec.model_validate(MINIMAL)
    assert spec.ref == "sample-bug@1"
    assert spec.metadata.partition == "dev"
    assert spec.hidden.fail_to_pass == ["hidden/test_bug.py"]


def test_extra_fields_forbidden():
    bad = {**MINIMAL, "surprise": 1}
    with pytest.raises(ValidationError):
        ScenarioSpec.model_validate(bad)


def test_network_open_rejected():
    bad = {**MINIMAL, "environment": {"profile": "python-glibc", "network": "open"}}
    with pytest.raises(ValidationError):
        ScenarioSpec.model_validate(bad)


def test_id_factories():
    assert new_trial_id().startswith("trial_")
    assert new_experiment_id().startswith("exp_")


def test_json_schema_accepts_minimal():
    from bakudo.schema import validate_scenario_spec
    validate_scenario_spec(MINIMAL)  # must not raise
