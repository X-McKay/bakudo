"""Trial runner tests (Task 7): objective derivation, budget/network
intersection, hack flags, and ``run_trial`` end to end against the exemplar
scenarios via a stubbed ``pipeline_fn`` and the ``BAKUDO_ENV=dev``-gated
local test runner (mirrors the verify-loop tests' own pattern)."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

from bakudo.agent_spec.models import SpecBudget
from bakudo.paths import scenarios_dir
from bakudo.registry import InMemoryLedger
from bakudo.scenarios.models import ScenarioBudgets, ScenarioExpect
from bakudo.scenarios.registry import ScenarioRegistry
from bakudo.scenarios.testrun import local_test_runner
from bakudo.trials.hidden import evaluate
from bakudo.trials.runner import (
    compute_hack_flags,
    intersect_budgets,
    intersect_network,
    objective_from_scenario,
    run_trial,
)


@pytest.fixture
def registry() -> ScenarioRegistry:
    return ScenarioRegistry(scenarios_dir())


@pytest.fixture(autouse=True)
def dev_env(monkeypatch):
    # run_trial's hidden-eval path uses local_test_runner, which is guarded
    # behind BAKUDO_ENV=dev (Task 5's guard; carried into T7 by ruling R2).
    monkeypatch.setenv("BAKUDO_ENV", "dev")


def _stub_result(status: str, changed_files: list[str]) -> SimpleNamespace:
    return SimpleNamespace(status=status, changed_files=changed_files)


def _reference_patch(scenario_path: Path) -> str:
    return (scenario_path / "reference" / "fix.patch").read_text()


# --------------------------------------------------------------------------
# run_trial end to end (stubbed pipeline_fn)
# --------------------------------------------------------------------------


def test_run_trial_offline_end_to_end(registry):
    scn = registry.get("csv-sum-offbyone@1")
    ref_patch = _reference_patch(scn.path)

    def stub_ok(objective, agent_ref, budgets, network):
        assert agent_ref == "debugger@1"
        return SimpleNamespace(
            diff=ref_patch,
            result=_stub_result("success", ["summer.py"]),
            denied_commands=[],
            scorecard=None,
        )

    rec = run_trial(
        scn,
        "debugger@1",
        seed=3,
        pipeline_fn=stub_ok,
        test_runner=local_test_runner,
        ledger=InMemoryLedger(),
    )

    assert rec.evaluation["f2p_rate"] == 1.0
    assert rec.evaluation["p2p_rate"] == 1.0
    assert rec.scenario_digest == scn.digest
    assert rec.seed == 3
    assert rec.status == "completed"
    assert rec.flags == rec.flags.__class__()  # no hack flags tripped


def test_bad_diff_scores_zero_f2p(registry):
    scn = registry.get("csv-sum-offbyone@1")

    def stub_no_fix(objective, agent_ref, budgets, network):
        return SimpleNamespace(
            diff="",
            result=_stub_result("failed", []),
            denied_commands=[],
            scorecard=None,
        )

    rec = run_trial(
        scn,
        "debugger@1",
        seed=1,
        pipeline_fn=stub_no_fix,
        test_runner=local_test_runner,
        ledger=InMemoryLedger(),
    )

    assert rec.evaluation["f2p_rate"] == 0.0
    # passToPass (header parsing) is unaffected by the bug, so it stays green
    # even though the candidate made no changes at all.
    assert rec.evaluation["p2p_rate"] == 1.0


def test_hack_flag_test_path(registry):
    scn = registry.get("csv-sum-offbyone@1")
    ref_patch = _reference_patch(scn.path)

    def stub_touches_tests(objective, agent_ref, budgets, network):
        return SimpleNamespace(
            diff=ref_patch,
            result=_stub_result("success", ["summer.py", "tests/test_x.py"]),
            denied_commands=[],
            scorecard=None,
        )

    rec = run_trial(
        scn,
        "debugger@1",
        seed=2,
        pipeline_fn=stub_touches_tests,
        test_runner=local_test_runner,
        ledger=InMemoryLedger(),
    )

    assert rec.flags.test_path_violation is True


def test_run_trial_records_to_ledger(registry):
    scn = registry.get("csv-sum-offbyone@1")
    ref_patch = _reference_patch(scn.path)
    ledger = InMemoryLedger()

    def stub_ok(objective, agent_ref, budgets, network):
        return SimpleNamespace(
            diff=ref_patch,
            result=_stub_result("success", ["summer.py"]),
            denied_commands=[],
            scorecard=None,
        )

    rec = run_trial(
        scn,
        "debugger@1",
        seed=5,
        pipeline_fn=stub_ok,
        test_runner=local_test_runner,
        ledger=ledger,
        experiment_id="exp_TEST",
    )

    assert ledger.get_trial(rec.id) == rec
    assert rec.experiment_id == "exp_TEST"


# --------------------------------------------------------------------------
# Budget / network intersection
# --------------------------------------------------------------------------


def test_budget_intersection_tighten_only():
    result = intersect_budgets(SpecBudget(maxTokens=50000), ScenarioBudgets(tokens=20000))
    assert result["tokens"] == 20000


def test_budget_intersection_scenario_only_field_carried_over():
    result = intersect_budgets(
        None, ScenarioBudgets(wallSeconds=600, toolCalls=30, tokens=20000)
    )
    assert result == {"wall_seconds": 600, "tool_calls": 30, "tokens": 20000}


def test_budget_intersection_agent_tighter_than_scenario():
    result = intersect_budgets(
        SpecBudget(maxToolCalls=5, maxTokens=100000), ScenarioBudgets(toolCalls=30, tokens=20000)
    )
    assert result["tool_calls"] == 5
    assert result["tokens"] == 20000


def test_network_intersection():
    assert intersect_network("scoped", "none") == "none"
    assert intersect_network("none", "open") == "none"
    assert intersect_network("open", "open") == "open"
    assert intersect_network("scoped", "scoped") == "scoped"


# --------------------------------------------------------------------------
# Hack flags (unit-level)
# --------------------------------------------------------------------------


def _expect(**overrides) -> ScenarioExpect:
    fields = dict(
        status="success",
        changesPaths=[],
        maxChangedFiles=1,
        forbidsDeniedCommands=True,
        testPathsImmutable=True,
    )
    fields.update(overrides)
    return ScenarioExpect(**fields)


def test_compute_hack_flags_scope_violation():
    flags = compute_hack_flags(["other.py"], [], _expect(changesPaths=["summer.py"]))
    assert flags.scope_violation is True


def test_compute_hack_flags_scope_ok_when_within_declared_paths():
    flags = compute_hack_flags(["src/pkg/file.py"], [], _expect(changesPaths=["src/pkg"]))
    assert flags.scope_violation is False


def test_compute_hack_flags_denied_retries():
    flags = compute_hack_flags([], ["rm -rf /", "rm -rf /"], _expect())
    assert flags.denied_action_retries is True


def test_compute_hack_flags_single_denied_command_not_a_retry():
    flags = compute_hack_flags([], ["rm -rf /"], _expect())
    assert flags.denied_action_retries is False


def test_compute_hack_flags_clean_run():
    flags = compute_hack_flags(["summer.py"], [], _expect(changesPaths=["summer.py"]))
    assert flags.test_path_violation is False
    assert flags.denied_action_retries is False
    assert flags.scope_violation is False


# --------------------------------------------------------------------------
# objective_from_scenario
# --------------------------------------------------------------------------


def test_objective_from_scenario_maps_mission(registry, tmp_path):
    scn = registry.get("csv-sum-offbyone@1")
    repo_path = tmp_path / "repo"
    obj = objective_from_scenario(scn, repo_path)

    assert obj.title == scn.spec.mission.title
    assert obj.description == scn.spec.mission.description
    assert obj.repo == str(repo_path)
    assert obj.acceptance_criteria == scn.spec.mission.acceptance_criteria
    assert obj.constraints.max_files_changed == scn.spec.expect.max_changed_files
    assert obj.type.value == scn.spec.mission.type


# --------------------------------------------------------------------------
# hidden.evaluate (direct)
# --------------------------------------------------------------------------


def test_nochange_scenario_empty_diff_passes(registry):
    scn = registry.get("rate-limiter-nochange@1")
    outcome = evaluate(scn, "", seed=0, runner=local_test_runner)
    assert outcome.f2p_rate == 1.0  # empty failToPass list -> vacuously 1.0
    assert outcome.p2p_rate == 1.0


def test_hidden_evaluate_reference_patch_scores_full(registry):
    scn = registry.get("csv-sum-offbyone@1")
    ref_patch = _reference_patch(scn.path)
    outcome = evaluate(scn, ref_patch, seed=0, runner=local_test_runner)
    assert outcome.f2p_rate == 1.0
    assert outcome.p2p_rate == 1.0
    assert outcome.reward == {"fail_to_pass_rate": 1.0, "pass_to_pass_rate": 1.0}


def test_hidden_evaluate_pristine_fixture_fails_f2p(registry):
    scn = registry.get("csv-sum-offbyone@1")
    outcome = evaluate(scn, "", seed=0, runner=local_test_runner)
    assert outcome.f2p_rate == 0.0
    assert outcome.p2p_rate == 1.0


def test_hidden_evaluate_runner_timeout_scores_zero_no_exception(registry):
    scn = registry.get("csv-sum-offbyone@1")
    ref_patch = _reference_patch(scn.path)

    def hanging_runner(workspace, command):
        raise subprocess.TimeoutExpired(cmd=command, timeout=120)

    outcome = evaluate(scn, ref_patch, seed=0, runner=hanging_runner)
    assert outcome.f2p_rate == 0.0
    assert outcome.p2p_rate == 0.0


# --------------------------------------------------------------------------
# build_pipeline_fn
# --------------------------------------------------------------------------


def test_build_pipeline_fn_intersects_budgets_and_network_before_run_objective(tmp_path):
    from bakudo.agent_spec import load_spec_file
    from bakudo.curriculum.objective import Objective
    from bakudo.trials.runner import build_pipeline_fn

    agents_dir = Path(__file__).resolve().parents[1] / "agents"
    spec = load_spec_file(agents_dir / "qa.yaml")  # networkMode: scoped, no budget set

    seen: dict = {}

    def fake_run_objective(objective, adjusted_spec, *, sandbox):
        seen["network_mode"] = adjusted_spec.sandbox.network_mode
        seen["timeout_seconds"] = adjusted_spec.sandbox.timeout_seconds
        seen["max_tokens"] = adjusted_spec.budget.max_tokens if adjusted_spec.budget else None
        # Exercise the sandbox wiring too, to prove repo_path threads through.
        sandbox(SimpleNamespace())
        return SimpleNamespace(
            outcome=SimpleNamespace(diff="", denied_commands=[]),
            result=_stub_result("blocked", []),
            scorecard=None,
        )

    sandbox_calls: list[Path] = []

    def sandbox_fn(bundle, repo_path):
        sandbox_calls.append(repo_path)
        return SimpleNamespace()

    pipeline_fn = build_pipeline_fn(
        spec, sandbox_fn=sandbox_fn, run_objective_fn=fake_run_objective
    )
    objective = Objective(type="qa", repo=str(tmp_path), title="t")
    scenario_budgets = ScenarioBudgets(wallSeconds=1800, toolCalls=30, tokens=5000)

    pr = pipeline_fn(objective, "qa@1", scenario_budgets, "none")

    from bakudo.agent_spec.models import NetworkMode

    # scoped (agent) vs none (scenario) -> none is more restrictive.
    assert seen["network_mode"] == NetworkMode.none
    assert seen["max_tokens"] == 5000  # no agent budget -> scenario value carried over
    assert sandbox_calls == [Path(tmp_path)]
    assert pr.diff == ""


def test_build_pipeline_fn_timeout_tighten_only(tmp_path):
    from bakudo.agent_spec import load_spec_file
    from bakudo.curriculum.objective import Objective
    from bakudo.trials.runner import build_pipeline_fn

    agents_dir = Path(__file__).resolve().parents[1] / "agents"
    base_spec = load_spec_file(agents_dir / "qa.yaml")
    spec = base_spec.model_copy(
        update={"sandbox": base_spec.sandbox.model_copy(update={"timeout_seconds": 300})}
    )

    seen: dict = {}

    def fake_run_objective(objective, adjusted_spec, *, sandbox):
        seen["timeout_seconds"] = adjusted_spec.sandbox.timeout_seconds
        return SimpleNamespace(
            outcome=SimpleNamespace(diff="", denied_commands=[]),
            result=_stub_result("blocked", []),
            scorecard=None,
        )

    pipeline_fn = build_pipeline_fn(
        spec,
        sandbox_fn=lambda bundle, repo_path: SimpleNamespace(),
        run_objective_fn=fake_run_objective,
    )
    objective = Objective(type="qa", repo=str(tmp_path), title="t")
    # Scenario wallSeconds (1800) is LOOSER than the agent's own 300s timeout
    # -- the effective timeout must stay at the tighter 300, never widen.
    scenario_budgets = ScenarioBudgets(wallSeconds=1800, toolCalls=30, tokens=5000)

    pipeline_fn(objective, "qa@1", scenario_budgets, "scoped")

    assert seen["timeout_seconds"] == 300


# --------------------------------------------------------------------------
# CLI: `bakudo trial run`
# --------------------------------------------------------------------------


def test_cli_trial_run_exits_nonzero_without_dev_env(monkeypatch, capsys):
    from bakudo.cli import main

    monkeypatch.delenv("BAKUDO_ENV", raising=False)
    rc = main(["trial", "run", "csv-sum-offbyone", "--agent", "qa@1"])
    assert rc == 2
    assert "BAKUDO_ENV=dev" in capsys.readouterr().err


def test_cli_trial_run_offline_json(monkeypatch, capsys):
    from bakudo.cli import main

    monkeypatch.setenv("BAKUDO_ENV", "dev")
    monkeypatch.setenv("BAKUDO_OFFLINE", "1")
    rc = main(["trial", "run", "csv-sum-offbyone", "--agent", "qa@1", "--seed", "7", "--json"])
    assert rc == 0
    out = json.loads(capsys.readouterr().out)
    assert out["agent_ref"] == "qa@1"
    assert out["seed"] == 7
    assert out["scenario_name"] == "csv-sum-offbyone"
    assert set(out["evaluation"]) >= {"f2p_rate", "p2p_rate"}


def test_cli_trial_run_unknown_scenario(monkeypatch, capsys):
    from bakudo.cli import main

    monkeypatch.setenv("BAKUDO_ENV", "dev")
    rc = main(["trial", "run", "does-not-exist", "--agent", "qa@1"])
    assert rc == 1
    assert "does-not-exist" in capsys.readouterr().err


def test_cli_trial_run_nonexistent_pinned_version_exits_2(monkeypatch, capsys):
    from bakudo.cli import main

    monkeypatch.setenv("BAKUDO_ENV", "dev")
    rc = main(["trial", "run", "csv-sum-offbyone", "--agent", "qa@99"])
    assert rc == 2
    err = capsys.readouterr().err
    assert "qa@99" in err or "99" in err


def test_cli_trial_run_bare_name_records_loaded_spec_ref(monkeypatch, capsys):
    from bakudo.cli import main

    monkeypatch.setenv("BAKUDO_ENV", "dev")
    monkeypatch.setenv("BAKUDO_OFFLINE", "1")
    rc = main(["trial", "run", "csv-sum-offbyone", "--agent", "qa", "--json"])
    assert rc == 0
    out = json.loads(capsys.readouterr().out)
    assert out["agent_ref"] == "qa@1"  # the loaded spec's real ref, not "qa"
