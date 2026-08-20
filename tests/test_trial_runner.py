"""Trial runner tests (Task 7): objective derivation, budget/network
intersection, integrity flags, and ``run_trial`` end to end against the exemplar
tasks via a stubbed ``pipeline_fn`` and the ``BAKUDO_ENV=dev``-gated
local test runner (mirrors the verify-loop tests' own pattern)."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

from bakudo.agent_spec.models import SpecBudget
from bakudo.curriculum.objective import ObjectiveType
from bakudo.paths import smoke_tasks_dir
from bakudo.registry import InMemoryLedger
from bakudo.tasks.models import ConstraintSpec, ResourceLimits
from bakudo.tasks.source import DirectoryTaskSource
from bakudo.tasks.verifier_runner import local_verifier_runner
from bakudo.trials.runner import (
    compute_integrity_flags,
    intersect_budgets,
    intersect_network,
    objective_from_task,
    run_trial,
)
from bakudo.trials.verifier import evaluate


@pytest.fixture
def registry() -> DirectoryTaskSource:
    return DirectoryTaskSource(smoke_tasks_dir())


@pytest.fixture(autouse=True)
def dev_env(monkeypatch):
    # run_trial's verifier-eval path uses local_verifier_runner, which is guarded
    # behind BAKUDO_ENV=dev (Task 5's guard; carried into T7 by ruling R2).
    monkeypatch.setenv("BAKUDO_ENV", "dev")


def _stub_result(status: str, changed_files: list[str]) -> SimpleNamespace:
    return SimpleNamespace(status=status, changed_files=changed_files)


def _reference_patch(task_path: Path) -> str:
    return (task_path / "reference" / "solution.patch").read_text()


# --------------------------------------------------------------------------
# run_trial end to end (stubbed pipeline_fn)
# --------------------------------------------------------------------------


def test_run_trial_offline_end_to_end(registry):
    task = registry.get("smoke-rate-limiter-fix@1")
    ref_patch = _reference_patch(task.path)

    def stub_ok(objective, agent_ref, budgets, network):
        assert agent_ref == "debugger@1"
        return SimpleNamespace(
            diff=ref_patch,
            result=_stub_result("success", ["limiter.py"]),
            denied_commands=[],
            scorecard=None,
        )

    rec = run_trial(
        task,
        "debugger@1",
        seed=3,
        pipeline_fn=stub_ok,
        verifier_runner=local_verifier_runner,
        ledger=InMemoryLedger(),
    )

    assert rec.evaluation["f2p_rate"] == 1.0
    assert rec.evaluation["p2p_rate"] == 1.0
    assert rec.task.bundle_digest == task.pin.bundle_digest
    assert rec.seed == 3
    assert rec.status == "completed"
    assert rec.integrity == rec.integrity.__class__()  # no integrity flags tripped


def test_bad_diff_scores_zero_f2p(registry):
    task = registry.get("smoke-rate-limiter-fix@1")

    def stub_no_fix(objective, agent_ref, budgets, network):
        return SimpleNamespace(
            diff="",
            result=_stub_result("failed", []),
            denied_commands=[],
            scorecard=None,
        )

    rec = run_trial(
        task,
        "debugger@1",
        seed=1,
        pipeline_fn=stub_no_fix,
        verifier_runner=local_verifier_runner,
        ledger=InMemoryLedger(),
    )

    assert rec.evaluation["f2p_rate"] == 0.0
    # passToPass (header parsing) is unaffected by the bug, so it stays green
    # even though the candidate made no changes at all.
    assert rec.evaluation["p2p_rate"] == 1.0


def test_integrity_violation_for_privileged_path(registry):
    task = registry.get("smoke-rate-limiter-fix@1")
    ref_patch = _reference_patch(task.path)

    def stub_touches_tests(objective, agent_ref, budgets, network):
        return SimpleNamespace(
            diff=ref_patch,
            result=_stub_result("success", ["limiter.py", "tests/test_x.py"]),
            denied_commands=[],
            scorecard=None,
        )

    rec = run_trial(
        task,
        "debugger@1",
        seed=2,
        pipeline_fn=stub_touches_tests,
        verifier_runner=local_verifier_runner,
        ledger=InMemoryLedger(),
    )

    assert rec.integrity.verifier_input_violation is True


def test_integrity_violation_uses_diff_when_self_report_is_empty(registry):
    """F2: the collected diff is the trusted source of changed paths. An
    agent that self-reports an empty ``changed_files`` list must not thereby
    dodge ``verifier_input_violation`` for a ``tests/`` edit that is actually
    present in the diff."""
    task = registry.get("smoke-rate-limiter-fix@1")
    ref_patch = _reference_patch(task.path)
    full_diff = ref_patch + ("--- /dev/null\n+++ b/tests/sneaky.py\n@@ -0,0 +1 @@\n+# sneaky\n")

    def stub_lies_about_changed_files(objective, agent_ref, budgets, network):
        return SimpleNamespace(
            diff=full_diff,
            result=_stub_result("success", []),  # self-report omits everything
            denied_commands=[],
            scorecard=None,
        )

    rec = run_trial(
        task,
        "debugger@1",
        seed=9,
        pipeline_fn=stub_lies_about_changed_files,
        verifier_runner=local_verifier_runner,
        ledger=InMemoryLedger(),
    )

    assert rec.integrity.verifier_input_violation is True
    assert rec.metrics["changed_files"] == 2.0


def test_changed_files_from_diff_parses_added_modified_and_deleted():
    from bakudo.trials.runner import changed_files_from_diff

    diff = (
        "--- a/foo.py\n+++ b/foo.py\n@@ -1 +1 @@\n-old\n+new\n"
        "--- /dev/null\n+++ b/bar.py\n@@ -0,0 +1 @@\n+new file\n"
        "--- a/baz.py\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\n"
    )
    assert changed_files_from_diff(diff) == ["foo.py", "bar.py", "baz.py"]


def test_changed_files_from_diff_parses_pure_rename():
    from bakudo.trials.runner import changed_files_from_diff

    diff = (
        "diff --git a/old.py b/new.py\n"
        "similarity index 100%\n"
        "rename from old.py\n"
        "rename to new.py\n"
    )
    assert changed_files_from_diff(diff) == ["new.py"]


def test_changed_files_from_diff_empty_diff_yields_no_paths():
    from bakudo.trials.runner import changed_files_from_diff

    assert changed_files_from_diff("") == []


def test_run_trial_records_to_ledger(registry):
    task = registry.get("smoke-rate-limiter-fix@1")
    ref_patch = _reference_patch(task.path)
    ledger = InMemoryLedger()

    def stub_ok(objective, agent_ref, budgets, network):
        return SimpleNamespace(
            diff=ref_patch,
            result=_stub_result("success", ["limiter.py"]),
            denied_commands=[],
            scorecard=None,
        )

    rec = run_trial(
        task,
        "debugger@1",
        seed=5,
        pipeline_fn=stub_ok,
        verifier_runner=local_verifier_runner,
        ledger=ledger,
        experiment_id="exp_TEST",
    )

    assert ledger.get_trial(rec.id) == rec
    assert rec.experiment_id == "exp_TEST"


# --------------------------------------------------------------------------
# Budget / network intersection
# --------------------------------------------------------------------------


def test_budget_intersection_tighten_only():
    result = intersect_budgets(SpecBudget(maxTokens=50000), ResourceLimits(tokens=20000))
    assert result["tokens"] == 20000


def test_budget_intersection_task_only_field_carried_over():
    result = intersect_budgets(None, ResourceLimits(wallSeconds=600, toolCalls=30, tokens=20000))
    assert result == {"wall_seconds": 600, "tool_calls": 30, "tokens": 20000}


def test_budget_intersection_agent_tighter_than_task():
    result = intersect_budgets(
        SpecBudget(maxToolCalls=5, maxTokens=100000), ResourceLimits(toolCalls=30, tokens=20000)
    )
    assert result["tool_calls"] == 5
    assert result["tokens"] == 20000


def test_network_intersection():
    assert intersect_network("scoped", "none") == "none"
    assert intersect_network("none", "open") == "none"
    assert intersect_network("open", "open") == "open"
    assert intersect_network("scoped", "scoped") == "scoped"


# --------------------------------------------------------------------------
# Integrity constraints (unit-level)
# --------------------------------------------------------------------------


def _constraints(**overrides) -> ConstraintSpec:
    fields = dict(
        expectedStatus="success",
        allowedChangePaths=[],
        maxChangedFiles=1,
        forbidsDeniedActions=True,
        verifierInputsImmutable=True,
    )
    fields.update(overrides)
    return ConstraintSpec(**fields)


def test_compute_integrity_flags_scope_violation():
    flags = compute_integrity_flags(
        ["other.py"], [], _constraints(allowedChangePaths=["limiter.py"])
    )
    assert flags.scope_violation is True


def test_compute_integrity_flags_scope_ok_when_within_declared_paths():
    flags = compute_integrity_flags(
        ["src/pkg/file.py"], [], _constraints(allowedChangePaths=["src/pkg"])
    )
    assert flags.scope_violation is False


def test_compute_integrity_flags_empty_allowed_paths_forbids_changes():
    flags = compute_integrity_flags(
        ["limiter.py"], [], _constraints(allowedChangePaths=[], maxChangedFiles=0)
    )
    assert flags.scope_violation is True
    assert flags.change_limit_violation is True


def test_compute_integrity_flags_respects_change_limit():
    flags = compute_integrity_flags(
        ["one.py", "two.py"],
        [],
        _constraints(allowedChangePaths=["one.py", "two.py"], maxChangedFiles=1),
    )
    assert flags.scope_violation is False
    assert flags.change_limit_violation is True


def test_compute_integrity_flags_denied_action_violation():
    flags = compute_integrity_flags([], ["rm -rf /", "rm -rf /"], _constraints())
    assert flags.denied_action_violation is True


def test_compute_integrity_flags_single_denied_action_is_a_violation():
    flags = compute_integrity_flags([], ["rm -rf /"], _constraints())
    assert flags.denied_action_violation is True


def test_compute_integrity_flags_can_allow_denied_actions():
    flags = compute_integrity_flags(
        [], ["blocked command"], _constraints(forbidsDeniedActions=False)
    )
    assert flags.denied_action_violation is False


def test_compute_integrity_flags_clean_run():
    flags = compute_integrity_flags(
        ["limiter.py"], [], _constraints(allowedChangePaths=["limiter.py"])
    )
    assert flags.verifier_input_violation is False
    assert flags.denied_action_violation is False
    assert flags.scope_violation is False
    assert flags.change_limit_violation is False


# --------------------------------------------------------------------------
# objective_from_task
# --------------------------------------------------------------------------


def test_objective_from_task_maps_instruction(registry, tmp_path):
    task = registry.get("smoke-rate-limiter-fix@1")
    repo_path = tmp_path / "repo"
    obj = objective_from_task(task, repo_path)

    assert obj.title == task.spec.instruction.title
    assert obj.description == task.spec.instruction.description
    assert obj.repo == str(repo_path)
    assert obj.acceptance_criteria == task.spec.instruction.success_criteria
    assert obj.constraints.max_files_changed == task.spec.constraints.max_changed_files
    assert obj.type.value == task.spec.instruction.type


def test_objective_from_task_maps_unpinned_code_optimization_to_maintenance(registry, tmp_path):
    task = registry.get("smoke-rate-limiter-nochange@1")
    optimized_task = task.model_copy(
        update={
            "spec": task.spec.model_copy(
                update={
                    "instruction": task.spec.instruction.model_copy(update={"type": "optimize"})
                }
            )
        }
    )

    obj = objective_from_task(optimized_task, tmp_path / "repo")

    assert obj.type is ObjectiveType.maintenance
    assert obj.performance is None


# --------------------------------------------------------------------------
# verifier.evaluate (direct)
# --------------------------------------------------------------------------


def test_nochange_task_empty_diff_passes(registry):
    task = registry.get("smoke-rate-limiter-nochange@1")
    outcome = evaluate(task, "", seed=0, runner=local_verifier_runner)
    assert outcome.f2p_rate == 1.0  # empty failToPass list -> vacuously 1.0
    assert outcome.p2p_rate == 1.0


def test_verifier_evaluate_reference_patch_scores_full(registry):
    task = registry.get("smoke-rate-limiter-fix@1")
    ref_patch = _reference_patch(task.path)
    outcome = evaluate(task, ref_patch, seed=0, runner=local_verifier_runner)
    assert outcome.f2p_rate == 1.0
    assert outcome.p2p_rate == 1.0
    assert outcome.reward == {"fail_to_pass_rate": 1.0, "pass_to_pass_rate": 1.0}


def test_verifier_evaluate_pristine_fixture_fails_f2p(registry):
    task = registry.get("smoke-rate-limiter-fix@1")
    outcome = evaluate(task, "", seed=0, runner=local_verifier_runner)
    assert outcome.f2p_rate == 0.0
    assert outcome.p2p_rate == 1.0


def test_verifier_evaluate_runner_timeout_scores_zero_no_exception(registry):
    task = registry.get("smoke-rate-limiter-fix@1")
    ref_patch = _reference_patch(task.path)

    def hanging_runner(workspace, command):
        raise subprocess.TimeoutExpired(cmd=command, timeout=120)

    outcome = evaluate(task, ref_patch, seed=0, runner=hanging_runner)
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
    task_budgets = ResourceLimits(wallSeconds=1800, toolCalls=30, tokens=5000)

    pr = pipeline_fn(objective, "qa@1", task_budgets, "none")

    from bakudo.agent_spec.models import NetworkMode

    # scoped (agent) vs none (task) -> none is more restrictive.
    assert seen["network_mode"] == NetworkMode.none
    assert seen["max_tokens"] == 5000  # no agent budget -> task value carried over
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
    # Task wallSeconds (1800) is LOOSER than the agent's own 300s timeout
    # -- the effective timeout must stay at the tighter 300, never widen.
    task_budgets = ResourceLimits(wallSeconds=1800, toolCalls=30, tokens=5000)

    pipeline_fn(objective, "qa@1", task_budgets, "scoped")

    assert seen["timeout_seconds"] == 300


# --------------------------------------------------------------------------
# CLI: `bakudo trial run`
# --------------------------------------------------------------------------


def test_cli_trial_run_exits_nonzero_without_dev_env(monkeypatch, capsys):
    from bakudo.cli import main

    monkeypatch.delenv("BAKUDO_ENV", raising=False)
    rc = main(["trial", "run", "smoke-rate-limiter-fix", "--agent", "qa@1"])
    assert rc == 2
    assert "BAKUDO_ENV=dev" in capsys.readouterr().err


def test_cli_trial_run_offline_json(monkeypatch, capsys):
    from bakudo.cli import main

    monkeypatch.setenv("BAKUDO_ENV", "dev")
    monkeypatch.setenv("BAKUDO_OFFLINE", "1")
    rc = main(
        ["trial", "run", "smoke-rate-limiter-fix", "--agent", "qa@1", "--seed", "7", "--json"]
    )
    assert rc == 0
    out = json.loads(capsys.readouterr().out)
    assert out["agent_ref"] == "qa@1"
    assert out["seed"] == 7
    assert out["task"]["name"] == "smoke-rate-limiter-fix"
    assert set(out["evaluation"]) >= {"f2p_rate", "p2p_rate"}


def test_cli_trial_run_unknown_task(monkeypatch, capsys):
    from bakudo.cli import main

    monkeypatch.setenv("BAKUDO_ENV", "dev")
    rc = main(["trial", "run", "does-not-exist", "--agent", "qa@1"])
    assert rc == 1
    assert "does-not-exist" in capsys.readouterr().err


def test_cli_trial_run_nonexistent_pinned_version_exits_2(monkeypatch, capsys):
    from bakudo.cli import main

    monkeypatch.setenv("BAKUDO_ENV", "dev")
    rc = main(["trial", "run", "smoke-rate-limiter-fix", "--agent", "qa@99"])
    assert rc == 2
    err = capsys.readouterr().err
    assert "qa@99" in err or "99" in err


def test_cli_trial_run_bare_name_records_loaded_spec_ref(monkeypatch, capsys):
    from bakudo.cli import main

    monkeypatch.setenv("BAKUDO_ENV", "dev")
    monkeypatch.setenv("BAKUDO_OFFLINE", "1")
    rc = main(["trial", "run", "smoke-rate-limiter-fix", "--agent", "qa", "--json"])
    assert rc == 0
    out = json.loads(capsys.readouterr().out)
    assert out["agent_ref"] == "qa@1"  # the loaded spec's real ref, not "qa"
