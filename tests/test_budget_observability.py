"""Phase D1/D2: budget enforcement and observability counters."""

import json
from pathlib import Path

import pytest

from bakudo.abox.local import local_sandbox
from bakudo.agent_spec import load_spec_file
from bakudo.bundle import Budget, TaskBundle
from bakudo.control import run_objective
from bakudo.curriculum import Objective
from bakudo.skills import SkillRegistry
from bakudo.strands_tools import BudgetExceeded, ToolContext, Workspace, build_tool_callables

AGENTS = Path(__file__).resolve().parents[1] / "agents"


def _ctx(tmp_path):
    spec = load_spec_file(AGENTS / "add-feature.yaml")
    return spec, ToolContext(
        workspace=Workspace(tmp_path),
        skills=SkillRegistry(allowed=spec.skills),
        run_id="run_X",
    )


def test_budget_blocks_tool_calls_past_deadline(tmp_path):
    spec, ctx = _ctx(tmp_path)
    ctx.set_budget(timeout_seconds=-1)  # already expired
    tools = build_tool_callables(spec, ctx)
    with pytest.raises(BudgetExceeded):
        tools["read-file"](path="anything")


def test_token_cap_enforced(tmp_path):
    spec, ctx = _ctx(tmp_path)
    ctx.set_budget(token_cap=10)
    ctx.tokens_used = 20
    tools = build_tool_callables(spec, ctx)
    with pytest.raises(BudgetExceeded):
        tools["git-diff"]()


def test_observability_counts_tool_calls_and_skills(tmp_path):
    spec, ctx = _ctx(tmp_path)
    tools = build_tool_callables(spec, ctx)
    tools["load-skill"](name="test-selection")
    obs = ctx.observability()
    assert obs["tool_calls"] == 1
    assert obs["skills_loaded"] == ["test-selection"]


def test_pipeline_records_observability_and_runtime():
    spec = load_spec_file(AGENTS / "add-feature.yaml")
    objective = Objective(type="add-feature", repo="bakudo", title="t")

    def driver(s, u, tools):
        tools["load-skill"](name="test-selection")
        return json.dumps({"status": "success", "summary": "done"})

    result = run_objective(
        objective, spec, sandbox=lambda b: local_sandbox(b, offline_driver=driver)
    )
    assert result.outcome.observability["tool_calls"] >= 1
    assert result.outcome.runtime_seconds >= 0.0


def test_budget_exceeded_yields_blocked_result():
    # A run that trips the budget is reported as blocked, not crashed.
    spec = load_spec_file(AGENTS / "add-feature.yaml")
    objective = Objective(type="add-feature", repo="bakudo", title="t")

    def budget_blowing_driver(s, u, tools):
        raise BudgetExceeded("timeout")

    out = local_sandbox(
        TaskBundle(run_id="run_Y", objective_id=objective.id, objective=objective,
                   agent_spec=spec, budget=Budget(timeoutSeconds=1)),
        offline_driver=budget_blowing_driver,
    )
    assert out.result["status"] == "blocked"
    assert any("budget" in r for r in out.result["blocked_reasons"])
