"""Phase 2: one pipeline core, enforced sandbox budgets, a shared optimize
driver, central Settings, and explicit status-enum state machines."""

import asyncio
from dataclasses import replace

import pytest

from bakudo.abox.runner import AboxOutcome
from bakudo.agent_spec import load_spec_file
from bakudo.cli import main as cli_main
from bakudo.config import Settings
from bakudo.control.optimize import drive_optimize
from bakudo.control.pipeline import enforce_sandbox_budgets
from bakudo.curriculum.objective import ObjectiveStatus
from bakudo.paths import agents_dir
from bakudo.registry import RunPhase
from bakudo.registry.ledger import InMemoryLedger

# --- sandbox budget enforcement (maxChangedFiles / maxDiffBytes are real) ---

def _spec(**sandbox_overrides):
    spec = load_spec_file(agents_dir() / "add-feature.yaml")
    if sandbox_overrides:
        spec = spec.model_copy(
            update={"sandbox": spec.sandbox.model_copy(update=sandbox_overrides)}
        )
    return spec


def _outcome(changed=(), diff="", status="success") -> AboxOutcome:
    return AboxOutcome(
        run_id="run_X",
        abox_task_id="run_X",
        exit_code=0,
        git_branch="agent/run_X",
        result={"status": status, "changed_files": list(changed)},
        diff=diff,
        changed_files=list(changed),
    )


def test_budget_enforcement_passes_within_limits():
    spec = _spec(max_changed_files=3, max_diff_bytes=1000)
    out = _outcome(changed=["a.py"], diff="+ok\n")
    assert enforce_sandbox_budgets(spec, out) is out


def test_budget_enforcement_fails_on_changed_files():
    spec = _spec(max_changed_files=1)
    out = enforce_sandbox_budgets(spec, _outcome(changed=["a.py", "b.py"]))
    assert not out.succeeded
    assert out.result["status"] == "failed"
    assert any("changed_files 2 > 1" in r for r in out.result["blocked_reasons"])


def test_budget_enforcement_fails_on_diff_bytes():
    spec = _spec(max_diff_bytes=4)
    out = enforce_sandbox_budgets(spec, _outcome(diff="+" * 100))
    assert not out.succeeded
    assert any("diff_bytes" in r for r in out.result["blocked_reasons"])


def test_budget_enforcement_noop_without_limits():
    spec = _spec(max_changed_files=None, max_diff_bytes=None)
    out = _outcome(changed=["a.py"] * 50, diff="x" * 100_000)
    assert enforce_sandbox_budgets(spec, out) is out


def test_budget_violation_preserves_existing_blocked_reasons():
    spec = _spec(max_changed_files=0)
    base = _outcome(changed=["a.py"])
    base = replace(base, result={**base.result, "blocked_reasons": ["earlier"]})
    out = enforce_sandbox_budgets(spec, base)
    assert out.result["blocked_reasons"][0] == "earlier"


# --- the shared optimize round driver ---

def _run_output(followups=None, score=0.9, status="success"):
    return {
        "run_id": "run_A",
        "git_branch": "agent/run_A",
        "result": {
            "status": status,
            "proposed_followups": followups or [],
            "changed_files": ["x.py"],
            "summary": "did a thing",
        },
        "scorecard": {
            "overall_score": score,
            "passed_suites": ["schema", "safety", "sandbox", "task", "code"],
            "suites": {"perf": 0.8, "simplicity": 0.5},
            "safety_regressions": 0,
            "critical_failures": 0,
        },
    }


def _drive(run_scout, run_attempt, **kwargs):
    async def gather_sequential(*coros):
        return [await c for c in coros]

    return asyncio.run(
        drive_optimize(
            {"title": "opt", "type": "optimize", "repo": "r", "constraints": {}},
            run_scout=run_scout,
            run_attempt=run_attempt,
            gather=gather_sequential,
            **kwargs,
        )
    )


def test_drive_optimize_improves_when_attempt_clears_gates():
    async def scout(doc):
        return _run_output(followups=["cache the hot path"])

    async def attempt(doc):
        return _run_output()

    out = _drive(scout, attempt)
    assert out["status"] == "improved"
    assert out["rounds_used"] == 1
    assert out["winner_run_id"] == "run_A"


def test_drive_optimize_no_change_when_scout_finds_nothing():
    async def scout(doc):
        return _run_output(followups=[])

    async def attempt(doc):  # pragma: no cover - must not be called
        raise AssertionError("no approaches -> no attempts")

    out = _drive(scout, attempt)
    assert out["status"] == "no-change"
    assert out["reason"] == "scout proposed no approaches"


def test_drive_optimize_reports_phases_and_exhausts_rounds():
    phases: list[tuple[int, str]] = []

    async def scout(doc):
        return _run_output(followups=["idea"])

    async def attempt(doc):
        return _run_output(status="failed")  # never eligible

    out = _drive(scout, attempt, max_rounds=2, on_phase=lambda r, p: phases.append((r, p)))
    assert out["status"] == "no-change"
    assert out["rounds_used"] == 2
    assert (1, "scouting") in phases and (2, "selecting") in phases


def test_drive_optimize_parallel_gather_matches_sequential():
    async def scout(doc):
        return _run_output(followups=["a", "b", "c"])

    async def attempt(doc):
        return _run_output()

    async def parallel():
        return await drive_optimize(
            {"title": "opt", "type": "optimize", "repo": "r", "constraints": {}},
            run_scout=scout,
            run_attempt=attempt,
            gather=asyncio.gather,
        )

    assert asyncio.run(parallel())["status"] == "improved"


# --- promotions() is on the Ledger protocol (no more duck-typing) ---

def test_in_memory_ledger_promotions_roundtrip():
    from bakudo.control import MetaAgentTools

    tools = MetaAgentTools()
    card = {
        "subject_type": "agent",
        "subject_id": "add-feature@2",
        "overall_score": 0.9,
        "suites": {"schema": 1.0, "safety": 1.0},
        "passed_suites": ["schema", "safety", "regression"],
        "failed_suites": [],
        "safety_regressions": 0,
        "critical_failures": 0,
        "cases_total": 30,
    }
    out = tools.promote_candidate(card, mutation_kinds=["new-secret-access"])
    assert out["decision"] == "needs_human"
    pending = [p for p in tools.ledger.promotions() if p.requires_human]
    assert len(pending) == 1


# --- central Settings ---

def test_settings_defaults_without_env(monkeypatch):
    for row in Settings.describe():
        monkeypatch.delenv(row["env"], raising=False)
    s = Settings.from_env()
    assert s.temporal_address == "localhost:7233"
    assert s.offline is False
    assert s.api_port == 8000
    assert s.postgres_dsn is None


def test_settings_reads_and_types_env(monkeypatch):
    monkeypatch.setenv("BAKUDO_OFFLINE", "1")
    monkeypatch.setenv("BAKUDO_API_PORT", "9001")
    monkeypatch.setenv("BAKUDO_SANDBOX", "abox")
    s = Settings.from_env()
    assert s.offline is True
    assert s.api_port == 9001
    assert s.sandbox_mode == "abox"


def test_settings_rejects_invalid_values(monkeypatch):
    from pydantic import ValidationError

    monkeypatch.setenv("BAKUDO_API_PORT", "not-a-port")
    with pytest.raises(ValidationError):
        Settings.from_env()


def test_settings_describe_covers_every_field_and_masks_secrets():
    rows = Settings.describe()
    assert {r["field"] for r in rows} == set(Settings.model_fields)
    assert all(r["env"] for r in rows)
    secret_envs = {r["env"] for r in rows if r["secret"]}
    assert "BAKUDO_API_TOKEN" in secret_envs and "GITHUB_TOKEN" in secret_envs


def test_settings_display_masks_secret_values(monkeypatch):
    monkeypatch.setenv("BAKUDO_API_TOKEN", "hunter2")
    s = Settings.from_env()
    assert s.display_value("api_token") == "*****"
    assert s.display_value("postgres_dsn") == "<unset>"


def test_cli_config_list_and_describe(capsys, monkeypatch):
    monkeypatch.setenv("BAKUDO_SANDBOX", "abox")
    assert cli_main(["config"]) == 0
    listed = capsys.readouterr().out
    assert "BAKUDO_SANDBOX" in listed and "abox" in listed

    assert cli_main(["config", "BAKUDO_SANDBOX"]) == 0
    detail = capsys.readouterr().out
    assert "fails closed" in detail

    assert cli_main(["config", "NO_SUCH_VAR"]) == 1


def test_resolve_base_url_fails_loudly(monkeypatch):
    from bakudo.runner.agent import _resolve_base_url

    monkeypatch.delenv("VLLM_BASE_URL", raising=False)
    with pytest.raises(RuntimeError, match="VLLM_BASE_URL"):
        _resolve_base_url(None)

    monkeypatch.setenv("VLLM_BASE_URL", "http://gw:8000/v1")
    assert _resolve_base_url(None) == "http://gw:8000/v1"
    # A spec-level ref wins over the shared default.
    monkeypatch.setenv("BAKUDO_VLLM_MAIN_POOL", "http://pool:8000/v1")
    assert _resolve_base_url("main-pool") == "http://pool:8000/v1"


# --- explicit status state machines ---

def test_run_phase_forward_transitions():
    assert RunPhase.created.can_transition_to(RunPhase.bundle_rendered)
    # Skipping intermediates forward is legal (the sync driver does it).
    assert RunPhase.bundle_rendered.can_transition_to(RunPhase.agent_running)
    assert not RunPhase.agent_running.can_transition_to(RunPhase.created)


def test_run_phase_failure_and_cancel_from_any_live_phase():
    for phase in RunPhase:
        if phase.is_terminal:
            continue
        assert phase.can_transition_to(RunPhase.failed)
        assert phase.can_transition_to(RunPhase.cancelled)


def test_run_phase_terminal_rules():
    assert RunPhase.completed.can_transition_to(RunPhase.archived)
    assert not RunPhase.completed.can_transition_to(RunPhase.agent_running)
    assert not RunPhase.archived.can_transition_to(RunPhase.archived)
    # archived is only reachable from a terminal phase.
    assert not RunPhase.evaluating.can_transition_to(RunPhase.archived)


def test_objective_status_state_machine():
    S = ObjectiveStatus
    assert S.ready.can_transition_to(S.running)
    assert S.running.can_transition_to(S.completed)
    assert S.failed.can_transition_to(S.ready)          # retry
    assert S.needs_human.can_transition_to(S.ready)     # human resolves
    assert not S.completed.can_transition_to(S.running)
    assert not S.archived.can_transition_to(S.ready)
    # Escalation is reachable from every live state.
    for status in (S.ready, S.blocked, S.running, S.failed):
        assert status.can_transition_to(S.needs_human)


# --- ledger protocol completeness ---

def test_in_memory_ledger_satisfies_protocol_shape():
    ledger = InMemoryLedger()
    for method in (
        "upsert_agent_version", "active_version", "get_agent_version",
        "create_run", "get_run", "set_phase", "finish_run",
        "append_event", "events",
        "record_eval", "eval_results", "record_promotion", "promotions",
    ):
        assert callable(getattr(ledger, method))
