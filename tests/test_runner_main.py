"""agent-runner entrypoint: observability + budget written into result.json.

ABOX-10: the guest must self-report tokens/runtime/tool counters so the host
(and evals) never grade on empty signals. ``result.schema.json`` allows only
numeric ``metrics``, so counters land there.
"""

import json
from pathlib import Path

from bakudo.agent_run_bundle import AgentRunBundle, budget_from_spec
from bakudo.agent_spec import load_spec_file
from bakudo.curriculum import Objective
from bakudo.runner.main import cli
from bakudo.schema import validate_result

AGENTS = Path(__file__).resolve().parents[1] / "agents"


def _write_bundle(tmp_path: Path) -> Path:
    spec = load_spec_file(AGENTS / "explore.yaml")
    objective = Objective(type="explore", repo="bakudo", title="map it")
    bundle = AgentRunBundle(
        run_id="run_MAIN1",
        objective_id=objective.id,
        objective=objective,
        agent_spec=spec,
        budget=budget_from_spec(spec),
    )
    path = tmp_path / "bundle.json"
    path.write_text(json.dumps(bundle.model_dump(by_alias=True, mode="json")))
    return path


def test_agent_runner_writes_observability_metrics(tmp_path, monkeypatch):
    monkeypatch.setenv("BAKUDO_OFFLINE", "1")
    bundle_path = _write_bundle(tmp_path)
    workspace = tmp_path / "ws"
    workspace.mkdir()
    result_path = tmp_path / "result.json"

    exit_code = cli(
        [
            "--bundle",
            str(bundle_path),
            "--result",
            str(result_path),
            "--workspace",
            str(workspace),
        ]
    )

    doc = json.loads(result_path.read_text())
    validate_result(doc)
    assert exit_code == 0  # offline driver reports blocked, not failed
    metrics = doc["metrics"]
    assert metrics["runtime_seconds"] >= 0.0
    assert metrics["tokens_used"] >= 0.0
    assert metrics["tool_calls"] >= 0.0
    assert metrics["model_calls"] >= 0.0
    assert metrics["denied_commands"] >= 0.0
