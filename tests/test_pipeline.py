import json
from pathlib import Path

from bakudo.abox.local import local_sandbox
from bakudo.agent_spec import load_spec_file
from bakudo.control import run_objective
from bakudo.curriculum import Objective
from bakudo.registry import InMemoryLedger, RunPhase

AGENTS = Path(__file__).resolve().parents[1] / "agents"


def _implementing_driver(system_prompt, user_prompt, tools):
    # A fake "model" that uses the edit-file tool then reports success.
    assert "result.json" in system_prompt  # output contract was injected
    if "edit-file" in tools:
        tools["edit-file"](path=".gitkeep", content="touched by add-feature\n")
    return json.dumps(
        {
            "status": "success",
            "summary": "Implemented the feature.",
            "tests_run": [{"command": "pytest -q", "status": "passed"}],
        }
    )


def _sandbox(bundle):
    return local_sandbox(bundle, offline_driver=_implementing_driver)


def test_run_objective_completes_and_scores():
    spec = load_spec_file(AGENTS / "add-feature.yaml")
    objective = Objective(
        type="add-feature", repo="bakudo", title="Add a thing",
        acceptanceCriteria=["adds the thing"],
    )
    ledger = InMemoryLedger()
    result = run_objective(objective, spec, ledger=ledger, sandbox=_sandbox)

    assert result.phase is RunPhase.completed
    assert result.result is not None
    assert result.result.status.value == "success"
    assert ".gitkeep" in result.result.changed_files
    assert result.scorecard is not None
    assert result.scorecard.safety_regressions == 0
    assert result.scorecard.overall_score > 0.5


def test_ledger_records_lifecycle_events():
    spec = load_spec_file(AGENTS / "explore.yaml")
    objective = Objective(type="explore", repo="bakudo", title="map it")
    ledger = InMemoryLedger()

    def explore_driver(s, u, tools):
        return json.dumps({"status": "success", "summary": "mapped"})

    result = run_objective(
        objective, spec, ledger=ledger,
        sandbox=lambda b: local_sandbox(b, offline_driver=explore_driver),
    )
    events = [e.event_type for e in ledger.events(result.run_id)]
    assert "created" in events
    assert "finished" in events
    run = ledger.get_run(result.run_id)
    assert run.phase is RunPhase.completed
    assert run.git_branch == f"agent/{result.run_id}"
