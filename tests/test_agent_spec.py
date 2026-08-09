from pathlib import Path

import pytest

from bakudo.agent_spec import dump_yaml, load_spec, load_spec_file
from bakudo.schema import SchemaValidationError

AGENTS = Path(__file__).resolve().parents[1] / "agents"


@pytest.mark.parametrize(
    "name",
    ["explore", "add-feature", "qa", "critic", "optimize-scout", "optimize-attempt"],
)
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


def test_model_enable_thinking_knob_parses(tmp_path):
    """enableThinking: false is a per-role model knob for structured-output
    roles on thinking models (scout/critic burn their output budget on
    deliberation otherwise)."""
    import yaml

    from bakudo.agent_spec import load_spec_file

    doc = yaml.safe_load((AGENTS / "optimize-scout.yaml").read_text())
    doc["model"]["enableThinking"] = False
    p = tmp_path / "s.yaml"
    p.write_text(yaml.safe_dump(doc))
    spec = load_spec_file(p)
    assert spec.model.enable_thinking is False


def test_model_enable_thinking_defaults_to_none():
    from bakudo.agent_spec import load_spec_file

    spec = load_spec_file(AGENTS / "explore.yaml")
    assert spec.model.enable_thinking is None


def test_spec_level_budget_parses(tmp_path):
    """Issue #27: a per-role `budget` section (maxToolCalls ceiling and
    optional run-level token/cost caps) is part of the spec schema."""
    import yaml

    doc = yaml.safe_load((AGENTS / "add-feature.yaml").read_text())
    doc["budget"] = {"maxToolCalls": 25, "maxTokens": 200000, "maxUsd": 2.5}
    p = tmp_path / "s.yaml"
    p.write_text(yaml.safe_dump(doc))
    spec = load_spec_file(p)
    assert spec.budget is not None
    assert spec.budget.max_tool_calls == 25
    assert spec.budget.max_tokens == 200000
    assert spec.budget.max_usd == 2.5


def test_spec_budget_defaults_to_none():
    spec = load_spec_file(AGENTS / "explore.yaml")
    assert spec.budget is None


def test_spec_budget_rejects_non_positive_ceiling(tmp_path):
    import yaml

    doc = yaml.safe_load((AGENTS / "add-feature.yaml").read_text())
    doc["budget"] = {"maxToolCalls": 0}
    p = tmp_path / "s.yaml"
    p.write_text(yaml.safe_dump(doc))
    with pytest.raises(SchemaValidationError):
        load_spec_file(p)
