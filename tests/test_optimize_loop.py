"""The in-process optimization loop end-to-end with a scripted sandbox.

Exercises the same round logic OptimizationWorkflow runs: scout proposes,
attempts implement in isolation, gates select a winner or feed failure back
into the next round — and "no safe improvement" is a first-class outcome.
"""

from __future__ import annotations

from bakudo import ids
from bakudo.abox.runner import AboxOutcome
from bakudo.control.optimize import load_role_spec, run_optimize_loop
from bakudo.curriculum.objective import Objective
from bakudo.performance.models import Verdict
from test_optimize import _performance_comparison, performance_contract

SCOUT = load_role_spec("optimize-scout")
ATTEMPT = load_role_spec("optimize-attempt")


def make_objective() -> Objective:
    return Objective.model_validate(
        {
            "id": ids.objective_id(),
            "type": "optimize",
            "repo": "payments-api",
            "title": "Optimize invoice listing",
            "description": "The listing endpoint is slow.",
            "acceptanceCriteria": ["All existing tests pass"],
            "performance": performance_contract(),
            "constraints": {
                "maxFilesChanged": 4,
                "targetPaths": ["src/billing/**"],
            },
        }
    )


class ScriptedSandbox:
    """Answers scout and attempt bundles from per-round scripts."""

    def __init__(self, rounds: list[dict]) -> None:
        # Each round: {"approaches": [...], "effects": [relative effect per approach]}
        self.rounds = rounds
        self.scout_calls = 0
        self.attempt_calls = 0
        self.scout_descriptions: list[str] = []
        self.effects_by_diff: dict[str, float] = {}

    def __call__(self, bundle) -> AboxOutcome:
        name = bundle.agent_spec.metadata.name
        base = {
            "run_id": bundle.run_id,
            "agent": f"{name}@1",
            "objective_id": bundle.objective_id,
            "summary": f"{name} run",
        }
        if name == "optimize-scout":
            script = self.rounds[self.scout_calls]
            self.scout_calls += 1
            self.scout_descriptions.append(bundle.objective.description)
            result = {
                **base,
                "status": "success",
                "proposed_followups": script["approaches"],
            }
        else:
            script = self.rounds[self.scout_calls - 1]
            index = self.attempt_calls % max(len(script["approaches"]), 1)
            self.attempt_calls += 1
            diff = f"diff --git a/x.py b/x.py\n+candidate-{self.attempt_calls}\n"
            self.effects_by_diff[diff] = script["effects"][index]
            reported_metrics = {}
            if script.get("reported_metrics"):
                reported_metrics.update(script["reported_metrics"][index])
            result = {
                **base,
                "status": "success",
                "changed_files": ["src/billing/listing.py"],
                "tests_run": [{"command": "pytest -q", "status": "passed"}],
                "metrics": reported_metrics,
            }
        return AboxOutcome(
            run_id=bundle.run_id,
            abox_task_id=bundle.run_id,
            exit_code=0,
            git_branch=f"bakudo/{bundle.run_id}",
            result=result,
            diff=diff if name != "optimize-scout" else "",
        )

    def compare(self, diff: str):
        return _performance_comparison(diff, effect=self.effects_by_diff[diff])


IMPROVED = 0.40
REGRESSED = -0.40
NEUTRAL = 0.0


def run_loop(objective: Objective, sandbox: ScriptedSandbox, **kwargs):
    return run_optimize_loop(
        objective,
        SCOUT,
        ATTEMPT,
        sandbox=sandbox,
        performance_compare=sandbox.compare,
        **kwargs,
    )


def test_loop_selects_best_attempt_in_one_round():
    sandbox = ScriptedSandbox(
        [
            {
                "approaches": ["batch queries", "cache totals"],
                "effects": [
                    0.20,
                    IMPROVED,
                ],
            }
        ]
    )
    outcome = run_loop(make_objective(), sandbox, max_rounds=2)
    assert outcome["status"] == "improved"
    assert outcome["rounds_used"] == 1
    assert outcome["performance_comparison"]["verdict"] == "improved"
    assert outcome["git_branch"].startswith("bakudo/")
    assert sandbox.attempt_calls == 2


def test_loop_reports_no_change_when_scout_finds_nothing():
    sandbox = ScriptedSandbox([{"approaches": [], "effects": []}])
    outcome = run_loop(make_objective(), sandbox)
    assert outcome == {
        "status": "no-change",
        "rounds_used": 1,
        "reason": "scout proposed no approaches",
    }
    assert sandbox.attempt_calls == 0


def test_loop_iterates_with_feedback_then_succeeds():
    sandbox = ScriptedSandbox(
        [
            {"approaches": ["inline the ORM"], "effects": [REGRESSED]},
            {"approaches": ["batch queries"], "effects": [IMPROVED]},
        ]
    )
    outcome = run_loop(make_objective(), sandbox, max_rounds=2)
    assert outcome["status"] == "improved"
    assert outcome["rounds_used"] == 2
    # Round 2's scout saw round 1's failure feedback in its objective.
    assert "comparison verdict is regressed" in sandbox.scout_descriptions[1]
    assert "regressed" not in sandbox.scout_descriptions[0]


def test_loop_gives_up_honestly_after_round_budget():
    sandbox = ScriptedSandbox(
        [
            {"approaches": ["idea one"], "effects": [REGRESSED]},
            {"approaches": ["idea two"], "effects": [NEUTRAL]},
        ]
    )
    outcome = run_loop(make_objective(), sandbox, max_rounds=2)
    assert outcome["status"] == "no-change"
    assert outcome["rounds_used"] == 2
    assert outcome["reason"] == "no attempt cleared the gates"
    assert any("equivalent" in line for line in outcome["feedback"])


def test_loop_caps_approaches_per_round():
    sandbox = ScriptedSandbox(
        [{"approaches": ["a", "b", "c", "d", "e"], "effects": [IMPROVED] * 5}]
    )
    outcome = run_loop(make_objective(), sandbox, max_approaches=2)
    assert outcome["status"] == "improved"
    assert sandbox.attempt_calls == 2


# --- OPT-12: a failed scout must never masquerade as "no-change" ---


class FailingScoutSandbox(ScriptedSandbox):
    """Scout runs fail `fail_times` times (runner error), then behave normally."""

    def __init__(self, rounds, fail_times=99):
        super().__init__(rounds)
        self.fail_times = fail_times

    def __call__(self, bundle) -> AboxOutcome:
        name = bundle.agent_spec.metadata.name
        if name == "optimize-scout" and self.fail_times > 0:
            self.fail_times -= 1
            self.failed_scout_calls = getattr(self, "failed_scout_calls", 0) + 1
            return AboxOutcome(
                run_id=bundle.run_id,
                abox_task_id=bundle.run_id,
                exit_code=1,
                git_branch=f"bakudo/{bundle.run_id}",
                result={
                    "run_id": bundle.run_id,
                    "agent": f"{name}@1",
                    "objective_id": bundle.objective_id,
                    "status": "failed",
                    "summary": "Runner error: MaxTokensReachedException: clipped",
                    "blocked_reasons": ["runner_exception"],
                },
            )
        return super().__call__(bundle)


def test_failed_scout_reports_scout_failed_not_no_change():
    sandbox = FailingScoutSandbox([{"approaches": [], "effects": []}])
    outcome = run_loop(make_objective(), sandbox)
    assert outcome["status"] == "scout-failed"
    assert "MaxTokensReachedException" in outcome["reason"]
    assert outcome["status"] != "no-change"


def test_failed_scout_is_retried_once_then_proceeds():
    sandbox = FailingScoutSandbox(
        [{"approaches": ["use a set"], "effects": [IMPROVED]}], fail_times=1
    )
    outcome = run_loop(make_objective(), sandbox)
    assert outcome["status"] == "improved"
    assert sandbox.failed_scout_calls == 1 and sandbox.scout_calls == 1  # retry ran


# --- issue #27: a blocked scout with no followups is a failure, not "no-change"


class BlockedScoutSandbox(ScriptedSandbox):
    """Scout runs end blocked (budget/denials halt) with scripted followups."""

    def __call__(self, bundle) -> AboxOutcome:
        out = super().__call__(bundle)
        if bundle.agent_spec.metadata.name == "optimize-scout":
            out.result["status"] = "blocked"
            out.result["blocked_reasons"] = ["budget:tool_calls"]
        return out


def test_blocked_scout_with_no_followups_is_scout_failed():
    """Observed live: a wall-clock-blocked scout with empty followups read as
    the 'code is already optimal' success outcome. It is a scout failure."""
    sandbox = BlockedScoutSandbox(
        [{"approaches": [], "effects": []}, {"approaches": [], "effects": []}]
    )
    outcome = run_loop(make_objective(), sandbox)
    assert outcome["status"] == "scout-failed"
    assert outcome["status"] != "no-change"
    assert sandbox.scout_calls == 2  # the one retry ran


def test_blocked_scout_with_followups_is_still_usable():
    """A halted scout that still delivered hypotheses feeds the attempts."""
    sandbox = BlockedScoutSandbox([{"approaches": ["batch queries"], "effects": [IMPROVED]}])
    outcome = run_loop(make_objective(), sandbox)
    assert outcome["status"] == "improved"
    assert sandbox.attempt_calls == 1


# --- PR7: only independently produced PerformanceComparison evidence wins ---


def test_trusted_comparison_selects_winner():
    sandbox = ScriptedSandbox(
        [{"approaches": ["batch queries", "cache totals"], "effects": [0.20, IMPROVED]}]
    )
    outcome = run_loop(make_objective(), sandbox)
    assert outcome["status"] == "improved"
    assert outcome["performance_comparison"]["verdict"] == "improved"


def test_agent_claim_cannot_override_regressed_comparison():
    sandbox = ScriptedSandbox(
        [
            {
                "approaches": ["batch queries"],
                "effects": [REGRESSED],
                "reported_metrics": [{"claimed_speedup": 1000.0}],
            }
        ]
    )
    outcome = run_loop(make_objective(), sandbox, max_rounds=1)
    assert outcome["status"] == "no-change"
    assert any("comparison verdict is regressed" in fb for fb in outcome["feedback"])


def test_rejected_winner_falls_through_to_next_eligible():
    sandbox = ScriptedSandbox([{"approaches": ["a", "b"], "effects": [REGRESSED, IMPROVED]}])
    outcome = run_loop(make_objective(), sandbox)
    assert outcome["status"] == "improved"
    assert outcome["result"]["summary"] == "optimize-attempt run"
    assert outcome["performance_comparison"]["verdict"] == "improved"


def test_missing_comparison_callback_fails_closed():
    sandbox = ScriptedSandbox([{"approaches": ["simplify"], "effects": [IMPROVED]}])
    outcome = run_optimize_loop(make_objective(), SCOUT, ATTEMPT, sandbox=sandbox, max_rounds=1)
    assert outcome["status"] == "no-change"
    assert any("comparison unavailable" in item for item in outcome["feedback"])


def test_patch_digest_mismatch_is_rejected():
    sandbox = ScriptedSandbox([{"approaches": ["simplify"], "effects": [IMPROVED]}])
    outcome = run_optimize_loop(
        make_objective(),
        SCOUT,
        ATTEMPT,
        sandbox=sandbox,
        max_rounds=1,
        performance_compare=lambda _diff: _performance_comparison(
            "diff --git a/other.py b/other.py\n+unbound\n", effect=IMPROVED
        ),
    )
    assert outcome["status"] == "no-change"
    assert any("patch digest" in item for item in outcome["feedback"])


def test_invalid_comparison_callback_result_fails_closed():
    sandbox = ScriptedSandbox([{"approaches": ["simplify"], "effects": [IMPROVED]}])
    outcome = run_optimize_loop(
        make_objective(),
        SCOUT,
        ATTEMPT,
        sandbox=sandbox,
        max_rounds=1,
        performance_compare=lambda _diff: {"verdict": "improved"},  # type: ignore[arg-type,return-value]
    )
    assert outcome["status"] == "no-change"
    assert any("comparison failed" in item for item in outcome["feedback"])


def test_protected_metric_regression_is_rejected():
    sandbox = ScriptedSandbox([{"approaches": ["simplify"], "effects": [IMPROVED]}])

    def compare(diff: str):
        return _performance_comparison(diff, effect=IMPROVED, protected_verdict=Verdict.regressed)

    outcome = run_optimize_loop(
        make_objective(),
        SCOUT,
        ATTEMPT,
        sandbox=sandbox,
        max_rounds=1,
        performance_compare=compare,
    )
    assert outcome["status"] == "no-change"
    assert any("protected metric" in item for item in outcome["feedback"])


class InfraFailingAttemptSandbox(ScriptedSandbox):
    """Attempts die at the abox level: no result.json, only an error string."""

    def __call__(self, bundle) -> AboxOutcome:
        out = super().__call__(bundle)
        if bundle.agent_spec.metadata.name != "optimize-scout":
            out.result = None
            out.exit_code = 1
            out.error = "abox path did not resolve a worktree for this task"
        return out


def test_feedback_carries_sandbox_error_for_resultless_attempts():
    """Diagnosing live cycles required a hand-rolled teeing sandbox because
    'run failed' feedback discarded the abox error entirely."""
    sandbox = InfraFailingAttemptSandbox([{"approaches": ["use a set"], "effects": [IMPROVED]}])
    outcome = run_loop(make_objective(), sandbox, max_rounds=1)
    assert outcome["status"] == "no-change"
    assert any("did not resolve a worktree" in fb for fb in outcome["feedback"])


def test_feedback_accumulates_across_rounds():
    """OPT-17: round-3's scout must still see round-1's dead ends, or it can
    re-propose them."""
    sandbox = ScriptedSandbox(
        [
            {"approaches": ["inline the ORM"], "effects": [REGRESSED]},
            {"approaches": ["cache totals"], "effects": [NEUTRAL]},
            {"approaches": ["batch queries"], "effects": [IMPROVED]},
        ]
    )
    outcome = run_loop(make_objective(), sandbox, max_rounds=3)
    assert outcome["status"] == "improved"
    round3_desc = sandbox.scout_descriptions[2]
    assert "comparison verdict is regressed" in round3_desc
    assert "comparison verdict is equivalent" in round3_desc
