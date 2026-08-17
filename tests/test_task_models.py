import pytest
from pydantic import ValidationError

from bakudo.ids import new_episode_id, new_experiment_id, new_trial_id
from bakudo.tasks.models import TaskSpec

MINIMAL = {
    "apiVersion": "bakudo.ai/v1alpha1",
    "kind": "TaskSpec",
    "metadata": {
        "name": "sample-bug",
        "version": 1,
        "family": "debugging",
        "difficulty": "easy",
        "tags": ["python"],
        "partition": "dev",
        "canary": "bakudo-canary-TESTGUID",
        "provenance": {
            "createdBy": "human",
            "createdAt": "2026-08-15",
            "sourceType": "hand-written",
            "eligibleForPromotion": True,
        },
    },
    "instruction": {
        "type": "qa",
        "title": "Fix the bug",
        "description": "There is a bug.",
        "successCriteria": ["tests pass"],
    },
    "environment": {"profile": "python-glibc", "network": "none"},
    "limits": {"wallSeconds": 600, "toolCalls": 30, "tokens": 20000},
    "verifier": {
        "failToPass": ["verifier/test_bug.py"],
        "passToPass": ["verifier/test_ok.py"],
        "command": "pytest {files} -q",
        "negativeControls": [],
    },
    "constraints": {
        "expectedStatus": "completed",
        "allowedChangePaths": ["app.py"],
        "maxChangedFiles": 2,
        "forbidsDeniedActions": True,
        "verifierInputsImmutable": True,
    },
}


def test_minimal_task_parses():
    spec = TaskSpec.model_validate(MINIMAL)
    assert spec.ref == "sample-bug@1"
    assert spec.metadata.partition == "dev"
    assert spec.verifier.fail_to_pass == ["verifier/test_bug.py"]


def test_extra_fields_forbidden():
    bad = {**MINIMAL, "surprise": 1}
    with pytest.raises(ValidationError):
        TaskSpec.model_validate(bad)


def test_network_open_rejected():
    bad = {**MINIMAL, "environment": {"profile": "python-glibc", "network": "open"}}
    with pytest.raises(ValidationError):
        TaskSpec.model_validate(bad)


def test_unknown_instruction_type_rejected():
    bad = {**MINIMAL, "instruction": {**MINIMAL["instruction"], "type": "unknown"}}
    with pytest.raises(ValidationError):
        TaskSpec.model_validate(bad)


def test_id_factories():
    assert new_trial_id().startswith("trial_")
    assert new_episode_id().startswith("episode_")
    assert new_experiment_id().startswith("exp_")


def test_json_schema_accepts_minimal():
    from bakudo.schema import validate_task_spec

    validate_task_spec(MINIMAL)  # must not raise
