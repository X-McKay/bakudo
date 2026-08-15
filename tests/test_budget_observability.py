"""Phase D1/D2: budget enforcement and observability counters."""

import json
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from bakudo.abox.local import local_sandbox
from bakudo.agent_spec import load_spec_file
from bakudo.bundle import Budget, TaskBundle, budget_from_spec
from bakudo.control import run_objective
from bakudo.curriculum import Objective
from bakudo.runner.agent import GUEST_DEADLINE_HEADROOM_SECONDS, TokenAccounting, build_and_run
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


def test_tool_call_ceiling_halts_the_loop(tmp_path):
    """Issue #27: the spec-level maxToolCalls ceiling is a hard halt that
    force-transitions the run into the report phase."""
    spec, ctx = _ctx(tmp_path)
    ctx.set_budget(tool_call_ceiling=2)
    tools = build_tool_callables(spec, ctx)
    tools["git-diff"]()
    tools["git-diff"]()
    with pytest.raises(BudgetExceeded, match="tool_calls"):
        tools["git-diff"]()


def test_tripped_denial_breaker_halts_the_loop(tmp_path):
    """Issue #27: once the denial circuit-breaker trips, the *loop* ends —
    every subsequent tool call raises a LoopHalt (observed live: a scout kept
    wandering within allowed commands until wall-clock)."""
    from bakudo.strands_tools import DenialsExhausted, LoopHalt

    spec, ctx = _ctx(tmp_path)
    tools = build_tool_callables(spec, ctx)
    for _ in range(5):
        out = tools["run-command"](command="curl http://blocked.example")
        assert out["denied"] is True
    with pytest.raises(DenialsExhausted):
        tools["read-file"](path="anything")
    assert issubclass(DenialsExhausted, LoopHalt)
    assert issubclass(BudgetExceeded, LoopHalt)


def test_report_phase_disarms_budget_enforcement(tmp_path):
    """Issue #27: the final report-extraction model call must not be killed
    by the very budget that ended the loop."""
    spec, ctx = _ctx(tmp_path)
    ctx.set_budget(timeout_seconds=-1, token_cap=1)  # both already exhausted
    ctx.tokens_used = 10
    ctx.begin_report_phase()
    ctx.check_budget()  # must not raise


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


# ---------------------------------------------------------------------------
# API-3/API-4: budget_from_spec, mid-run token accounting, timeout clamping
# ---------------------------------------------------------------------------


def test_budget_from_spec_always_reads_timeout():
    spec = load_spec_file(AGENTS / "explore.yaml")
    budget = budget_from_spec(spec)
    assert budget.timeout_seconds == spec.sandbox.timeout_seconds
    assert budget.max_tokens is None  # explore.yaml declares no run token budget


def test_budget_from_spec_reads_optional_budget_fields():
    # Forward-compatible: a spec-shaped object carrying budget fields is honoured.
    spec = SimpleNamespace(
        sandbox=SimpleNamespace(timeout_seconds=120),
        budget=SimpleNamespace(max_tokens=5000, max_usd=1.5),
    )
    budget = budget_from_spec(spec)
    assert budget.timeout_seconds == 120
    assert budget.max_tokens == 5000
    assert budget.max_usd == 1.5


def test_budget_from_spec_reads_max_tool_calls(tmp_path):
    """Issue #27: the spec-level maxToolCalls ceiling rides the run Budget."""
    import yaml

    from bakudo.agent_spec import load_spec_file as load

    doc = yaml.safe_load((AGENTS / "optimize-scout.yaml").read_text())
    doc["budget"] = {"maxToolCalls": 25}
    p = tmp_path / "s.yaml"
    p.write_text(yaml.safe_dump(doc))
    budget = budget_from_spec(load(p))
    assert budget.max_tool_calls == 25


def test_guest_deadline_has_headroom_below_abox_timeout():
    # ABOX-16: the in-guest deadline must beat the VM kill (abox --timeout).
    spec = load_spec_file(AGENTS / "explore.yaml")
    objective = Objective(type="explore", repo="bakudo", title="t")
    bundle = TaskBundle(
        run_id="run_H", objective_id=objective.id, objective=objective,
        agent_spec=spec, budget=Budget(timeoutSeconds=1000),
    )
    ctx = ToolContext(
        workspace=Workspace(Path(".")), skills=SkillRegistry(allowed=[]), run_id="run_H",
    )
    build_and_run(spec, bundle, ctx, offline_driver=lambda s, u, t: "{}")
    remaining = ctx.deadline_monotonic - time.monotonic()
    assert 0 < remaining <= 1000 - GUEST_DEADLINE_HEADROOM_SECONDS + 1


def test_token_accounting_trips_cap_mid_run():
    ctx = ToolContext(
        workspace=Workspace(Path(".")), skills=SkillRegistry(allowed=[]), run_id="run_T",
    )
    ctx.set_budget(token_cap=100)
    hook = TokenAccounting(ctx)

    event = SimpleNamespace(
        agent=SimpleNamespace(
            event_loop_metrics=SimpleNamespace(accumulated_usage={"totalTokens": 120})
        )
    )
    with pytest.raises(BudgetExceeded, match="token_cap"):
        hook.on_model_call(event)
    assert ctx.tokens_used == 120
    assert ctx.model_calls == 1


def test_token_accounting_accumulates_deltas():
    ctx = ToolContext(
        workspace=Workspace(Path(".")), skills=SkillRegistry(allowed=[]), run_id="run_T",
    )
    hook = TokenAccounting(ctx)

    def event(total):
        return SimpleNamespace(
            agent=SimpleNamespace(
                event_loop_metrics=SimpleNamespace(accumulated_usage={"totalTokens": total})
            )
        )

    hook.on_model_call(event(50))
    hook.on_model_call(event(80))
    assert ctx.tokens_used == 80  # cumulative source, delta-accounted
    assert ctx.model_calls == 2


def test_run_command_timeout_clamped_to_remaining_budget(tmp_path):
    # API-4: the model may not extend its own wall clock via run-command timeout.
    spec, ctx = _ctx(tmp_path)
    ctx.set_budget(timeout_seconds=5)
    seen = {}
    real_run = ctx.workspace.run

    def spying_run(argv, timeout=600):
        seen["timeout"] = timeout
        return real_run(argv, timeout=timeout)

    ctx.workspace.run = spying_run
    tools = build_tool_callables(spec, ctx)
    tools["run-command"](command="echo hi", timeout=600)
    assert seen["timeout"] <= 5


def test_run_command_subprocess_timeout_reported_not_raised(tmp_path):
    spec, ctx = _ctx(tmp_path)
    tools = build_tool_callables(spec, ctx)
    # An allowlisted, long-running command (binds an ephemeral port and serves
    # forever) — `python -c` is denied by the inline-exec guard (SEC-1), so use
    # `python -m` to exercise the subprocess-timeout path.
    out = tools["run-command"](command="python -m http.server 0", timeout=1)
    assert out["exit_code"] == 124
    assert out["timed_out"] is True
