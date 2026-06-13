from pathlib import Path

import pytest

from bakudo.agent_spec import dump_yaml, load_spec, load_spec_file
from bakudo.schema import SchemaValidationError

AGENTS = Path(__file__).resolve().parents[1] / "agents"


@pytest.mark.parametrize("name", ["explore", "add-feature", "qa", "critic"])
def test_seed_specs_load_and_validate(name):
    spec = load_spec_file(AGENTS / f"{name}.yaml")
    assert spec.metadata.name == name
    assert spec.ref == f"{name}@{spec.metadata.version}"
    assert spec.output_contract.required_files == ["result.json"]


def test_round_trip_preserves_ref():
    spec = load_spec_file(AGENTS / "add-feature.yaml")
    reloaded = load_spec(dump_yaml(spec))
    assert reloaded.ref == spec.ref
    assert reloaded.tool_names() == spec.tool_names()


def test_invalid_role_is_rejected_by_schema():
    bad = """
apiVersion: meta-agent.ai/v1alpha1
kind: AgentSpec
metadata: {name: x, version: 1, status: active}
role: {type: not-a-role}
model: {provider: openai-compatible, modelId: m}
sandbox: {provider: abox, profile: p}
prompt: {system: hi}
outputContract: {requiredFiles: [result.json]}
"""
    with pytest.raises(SchemaValidationError):
        load_spec(bad)
