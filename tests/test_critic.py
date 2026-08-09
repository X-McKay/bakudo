"""The sandboxed critic eval (design 2026-08-09 §5, fixes OPT-8).

``critic_eval`` runs the ``critic`` role as a real read-only agent through the
same sandbox driver abstraction as the pipeline (tests inject a fake driver
returning a canned verdict). Failure semantics: sandbox/schema failure ERRORS
the suite (no silent pass, no fabricated abstention); no sandbox omits it.
"""

from __future__ import annotations

import pytest

from bakudo.abox.runner import AboxOutcome
from bakudo.curriculum import Objective
from bakudo.evals.checks import EvalContext
from bakudo.evals.critic import critic_eval
from bakudo.runner.result import RunResult

DIFF = "--- a/a.py\n+++ b/a.py\n+code\n"


def _ctx():
    result = RunResult.model_validate({
        "run_id": "run_X", "agent": "add-feature@1", "objective_id": "obj_X",
        "status": "success", "summary": "did it", "changed_files": ["a.py"],
    })
    return EvalContext(
        result=result,
        objective=Objective(type="add-feature", repo="payments-api", title="t"),
        diff=DIFF,
    )


def _verdict_outcome(bundle, *, score=0.9, passed=True, issues=()):
    """A canned critic run: the pinned verdict rides the result.json envelope
    (metrics.score, metrics.passed, issues as proposedFollowups)."""
    return AboxOutcome(
        run_id=bundle.run_id,
        abox_task_id=bundle.run_id,
        exit_code=0,
        git_branch=f"agent/{bundle.run_id}",
        result={
            "run_id": bundle.run_id,
            "agent": "critic@1",
            "objective_id": bundle.objective_id,
            "status": "success",
            "summary": "reviewed the candidate",
            "metrics": {"score": score, "passed": 1.0 if passed else 0.0},
            "proposed_followups": list(issues),
        },
    )


def _sandbox(**verdict):
    def run(bundle):
        return _verdict_outcome(bundle, **verdict)

    return run


# --- suite omission: no sandbox, no critic suite (never a fabricated pass) ---


def test_no_sandbox_omits_the_critic_suite():
    assert critic_eval(_ctx()) is None
    assert critic_eval(_ctx(), None) is None


def test_critic_module_has_no_abstention_path():
    """The fabricated 1.0 abstention is gone: there is no judge protocol left."""
    import bakudo.evals.critic as critic_mod

    assert not hasattr(critic_mod, "llm_judge")
    assert not hasattr(critic_mod, "Judge")


# --- verdict grading through a fake sandbox driver ---


def test_clean_verdict_passes():
    res = critic_eval(_ctx(), _sandbox(score=0.95, passed=True))
    assert res is not None
    assert res.suite_name == "critic"
    assert res.subject_id == "run_X"
    assert res.passed is True
    assert res.score == 0.95


def test_verdict_with_issues_fails():
    res = critic_eval(
        _ctx(),
        _sandbox(score=0.2, passed=False, issues=["no tests", "race condition"]),
    )
    assert res.passed is False
    assert res.score == 0.2
    assert res.details["issues"] == ["no tests", "race condition"]
    assert res.details["issue_count"] == 2


def test_verdict_score_is_clamped_to_unit_interval():
    assert critic_eval(_ctx(), _sandbox(score=1.7)).score == 1.0
    assert critic_eval(_ctx(), _sandbox(score=-0.5, passed=False)).score == 0.0


def test_critic_runs_the_critic_role_over_the_candidate_diff():
    """The critic bundle targets the candidate's diff/branch as review target
    and uses the read-only critic role spec."""
    captured = {}

    def sandbox(bundle):
        captured["bundle"] = bundle
        return _verdict_outcome(bundle)

    critic_eval(_ctx(), sandbox)
    bundle = captured["bundle"]
    assert bundle.agent_spec.metadata.name == "critic"
    assert bundle.objective.type.value == "critic"
    assert bundle.objective.repo == "payments-api"
    assert "agent/run_X" in bundle.objective.description, "candidate branch missing"
    assert DIFF.strip() in bundle.objective.description, "candidate diff missing"
    assert bundle.run_id != "run_X", "the critic run gets its own run id"


# --- failure semantics: ERROR, never a silent pass ---


def _assert_errored(res, match):
    assert res is not None
    assert res.passed is False
    assert res.score == 0.0
    assert res.details["errored"] is True
    assert match in res.details["error"]


def test_sandbox_exception_errors_the_suite():
    def sandbox(bundle):
        raise RuntimeError("abox exploded")

    _assert_errored(critic_eval(_ctx(), sandbox), "abox exploded")


def test_failed_sandbox_outcome_errors_the_suite():
    def sandbox(bundle):
        return AboxOutcome(
            run_id=bundle.run_id, abox_task_id=bundle.run_id,
            exit_code=1, git_branch="", result=None, error="no result.json",
        )

    _assert_errored(critic_eval(_ctx(), sandbox), "no result.json")


def test_missing_verdict_errors_the_suite():
    def sandbox(bundle):
        out = _verdict_outcome(bundle)
        out.result["metrics"] = {}  # schema failure: verdict absent
        return out

    _assert_errored(critic_eval(_ctx(), sandbox), "verdict")


# --- eval-activity wiring: sandbox available -> suite present; else omitted ---


@pytest.fixture
def _eval_input():
    from bakudo.temporal.shared import EvalInput

    return EvalInput(
        run_id="run_X",
        objective={"id": "obj_X", "type": "add-feature", "repo": "payments-api",
                   "title": "t"},
        result={"run_id": "run_X", "agent": "add-feature@1", "objective_id": "obj_X",
                "status": "success", "summary": "ok"},
        diff=DIFF,
    )


def test_run_eval_suite_includes_critic_when_sandbox_available(
    monkeypatch, _eval_input
):
    from bakudo.temporal import _impl

    monkeypatch.setattr(_impl.DEPS, "sandbox", _sandbox(score=0.9, passed=True))
    out = _impl.run_eval_suite(_eval_input)
    suites = {r["suite_name"]: r for r in out["eval_results"]}
    assert "critic" in suites
    assert suites["critic"]["passed"] is True
    assert out["scorecard"]["suites"]["critic"] == 0.9


def test_run_eval_suite_omits_critic_without_sandbox(monkeypatch, _eval_input):
    from bakudo.temporal import _impl

    monkeypatch.setattr(_impl.DEPS, "sandbox", None)
    for var in ("BAKUDO_SANDBOX", "BAKUDO_USE_ABOX", "BAKUDO_ENV"):
        monkeypatch.delenv(var, raising=False)
    out = _impl.run_eval_suite(_eval_input)
    assert "critic" not in {r["suite_name"] for r in out["eval_results"]}


# --- the critic agent contract is the pinned verdict ---


def test_critic_yaml_contract_is_the_pinned_verdict():
    from pathlib import Path

    import yaml

    doc = yaml.safe_load(
        (Path(__file__).resolve().parents[1] / "agents" / "critic.yaml").read_text()
    )
    schema = doc["outputContract"]["resultSchema"]
    assert set(schema) == {"score", "passed", "issues"}
