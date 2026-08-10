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
            "constraints": {
                "maxFilesChanged": 4,
                "benchCommand": "pytest tests/benchmarks -q",
                "targetPaths": ["src/billing/**"],
            },
        }
    )


class ScriptedSandbox:
    """Answers scout and attempt bundles from per-round scripts."""

    def __init__(self, rounds: list[dict]) -> None:
        # Each round: {"approaches": [...], "metrics": [{...} per approach]}
        self.rounds = rounds
        self.scout_calls = 0
        self.attempt_calls = 0
        self.scout_descriptions: list[str] = []

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
            result = {
                **base,
                "status": "success",
                "changed_files": ["src/billing/listing.py"],
                "tests_run": [{"command": "pytest -q", "status": "passed"}],
                "metrics": script["metrics"][index],
            }
        return AboxOutcome(
            run_id=bundle.run_id,
            abox_task_id=bundle.run_id,
            exit_code=0,
            git_branch=f"bakudo/{bundle.run_id}",
            result=result,
        )


IMPROVED = {"bench_seconds_before": 10.0, "bench_seconds_after": 6.0}
REGRESSED = {"bench_seconds_before": 10.0, "bench_seconds_after": 14.0}
NEUTRAL: dict = {}


def test_loop_selects_best_attempt_in_one_round():
    sandbox = ScriptedSandbox(
        [{"approaches": ["batch queries", "cache totals"], "metrics": [
            {"bench_seconds_before": 10.0, "bench_seconds_after": 8.0},
            IMPROVED,
        ]}]
    )
    outcome = run_optimize_loop(
        make_objective(), SCOUT, ATTEMPT, sandbox=sandbox, max_rounds=2
    )
    assert outcome["status"] == "improved"
    assert outcome["rounds_used"] == 1
    assert outcome["scorecard"]["suites"]["perf"] == 0.9  # 40% improvement
    assert outcome["git_branch"].startswith("bakudo/")
    assert sandbox.attempt_calls == 2


def test_loop_reports_no_change_when_scout_finds_nothing():
    sandbox = ScriptedSandbox([{"approaches": [], "metrics": []}])
    outcome = run_optimize_loop(make_objective(), SCOUT, ATTEMPT, sandbox=sandbox)
    assert outcome == {
        "status": "no-change",
        "rounds_used": 1,
        "reason": "scout proposed no approaches",
    }
    assert sandbox.attempt_calls == 0


def test_loop_iterates_with_feedback_then_succeeds():
    sandbox = ScriptedSandbox(
        [
            {"approaches": ["inline the ORM"], "metrics": [REGRESSED]},
            {"approaches": ["batch queries"], "metrics": [IMPROVED]},
        ]
    )
    outcome = run_optimize_loop(
        make_objective(), SCOUT, ATTEMPT, sandbox=sandbox, max_rounds=2
    )
    assert outcome["status"] == "improved"
    assert outcome["rounds_used"] == 2
    # Round 2's scout saw round 1's failure feedback in its objective.
    assert "regressed perf or simplicity" in sandbox.scout_descriptions[1]
    assert "regressed" not in sandbox.scout_descriptions[0]


def test_loop_gives_up_honestly_after_round_budget():
    sandbox = ScriptedSandbox(
        [
            {"approaches": ["idea one"], "metrics": [REGRESSED]},
            {"approaches": ["idea two"], "metrics": [NEUTRAL]},
        ]
    )
    outcome = run_optimize_loop(
        make_objective(), SCOUT, ATTEMPT, sandbox=sandbox, max_rounds=2
    )
    assert outcome["status"] == "no-change"
    assert outcome["rounds_used"] == 2
    assert outcome["reason"] == "no attempt cleared the gates"
    # Neutral metrics = churn without measured benefit; named in feedback.
    assert any("no measured improvement" in line for line in outcome["feedback"])


def test_loop_caps_approaches_per_round():
    sandbox = ScriptedSandbox(
        [{"approaches": ["a", "b", "c", "d", "e"], "metrics": [IMPROVED] * 5}]
    )
    outcome = run_optimize_loop(
        make_objective(), SCOUT, ATTEMPT, sandbox=sandbox, max_approaches=2
    )
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
                run_id=bundle.run_id, abox_task_id=bundle.run_id, exit_code=1,
                git_branch=f"bakudo/{bundle.run_id}",
                result={
                    "run_id": bundle.run_id, "agent": f"{name}@1",
                    "objective_id": bundle.objective_id, "status": "failed",
                    "summary": "Runner error: MaxTokensReachedException: clipped",
                    "blocked_reasons": ["runner_exception"],
                },
            )
        return super().__call__(bundle)


def test_failed_scout_reports_scout_failed_not_no_change():
    sandbox = FailingScoutSandbox([{"approaches": [], "metrics": []}])
    outcome = run_optimize_loop(make_objective(), SCOUT, ATTEMPT, sandbox=sandbox)
    assert outcome["status"] == "scout-failed"
    assert "MaxTokensReachedException" in outcome["reason"]
    assert outcome["status"] != "no-change"


def test_failed_scout_is_retried_once_then_proceeds():
    sandbox = FailingScoutSandbox(
        [{"approaches": ["use a set"], "metrics": [IMPROVED]}], fail_times=1
    )
    outcome = run_optimize_loop(make_objective(), SCOUT, ATTEMPT, sandbox=sandbox)
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
        [{"approaches": [], "metrics": []}, {"approaches": [], "metrics": []}]
    )
    outcome = run_optimize_loop(make_objective(), SCOUT, ATTEMPT, sandbox=sandbox)
    assert outcome["status"] == "scout-failed"
    assert outcome["status"] != "no-change"
    assert sandbox.scout_calls == 2  # the one retry ran


def test_blocked_scout_with_followups_is_still_usable():
    """A halted scout that still delivered hypotheses feeds the attempts."""
    sandbox = BlockedScoutSandbox(
        [{"approaches": ["batch queries"], "metrics": [IMPROVED]}]
    )
    outcome = run_optimize_loop(make_objective(), SCOUT, ATTEMPT, sandbox=sandbox)
    assert outcome["status"] == "improved"
    assert sandbox.attempt_calls == 1


# --- issue #28 (OPT-3): winner selection must survive independent re-bench ---


def _measured(before, after):
    """A fake bench measurer: (diff, bench_command) -> measured seconds."""

    def measure(diff, bench_command):
        assert bench_command  # only called when the objective benches
        return before, after

    return measure


def test_verified_winner_is_selected():
    sandbox = ScriptedSandbox(
        [{"approaches": ["batch queries", "cache totals"], "metrics": [
            {"bench_seconds_before": 10.0, "bench_seconds_after": 8.0},
            IMPROVED,
        ]}]
    )
    outcome = run_optimize_loop(
        make_objective(), SCOUT, ATTEMPT, sandbox=sandbox,
        bench_measure=_measured(10.0, 5.9),
    )
    assert outcome["status"] == "improved"
    assert outcome["bench_verified"] is True


def test_unverifiable_winner_is_rejected_not_trusted():
    """A winner whose self-reported speedup does not reproduce independently
    must not be selected (OPT-3: a dishonest/mistaken attempt wins)."""
    sandbox = ScriptedSandbox(
        [{"approaches": ["batch queries"], "metrics": [IMPROVED]}]
    )
    outcome = run_optimize_loop(
        make_objective(), SCOUT, ATTEMPT, sandbox=sandbox, max_rounds=1,
        bench_measure=_measured(10.0, 10.1),  # no real improvement
    )
    assert outcome["status"] == "no-change"
    assert any("verification" in fb for fb in outcome["feedback"])


def test_rejected_winner_falls_through_to_next_eligible():
    """Verification rejects candidates one at a time; the next eligible
    attempt gets its own independent measurement."""
    calls = []

    def measure(diff, bench_command):
        calls.append(diff)
        # First verification fails to reproduce, second reproduces.
        return (10.0, 10.0) if len(calls) == 1 else (10.0, 4.0)

    sandbox = ScriptedSandbox(
        [{"approaches": ["a", "b"], "metrics": [
            IMPROVED,  # ranks first (40% claimed)
            {"bench_seconds_before": 10.0, "bench_seconds_after": 7.0},
        ]}]
    )
    outcome = run_optimize_loop(
        make_objective(), SCOUT, ATTEMPT, sandbox=sandbox,
        bench_measure=measure,
    )
    assert outcome["status"] == "improved"
    assert outcome["bench_verified"] is True
    assert len(calls) == 2


def test_no_bench_command_skips_verification():
    objective = make_objective()
    objective.constraints.bench_command = None
    sandbox = ScriptedSandbox(
        [{"approaches": ["simplify"], "metrics": [
            # No bench: improvement must come from another measured axis.
            {"complexity_before": 20.0, "complexity_after": 10.0},
        ]}]
    )
    outcome = run_optimize_loop(
        objective, SCOUT, ATTEMPT, sandbox=sandbox,
        bench_measure=_measured(0.0, 0.0),
    )
    assert outcome["status"] == "improved"
    assert outcome["bench_verified"] is False  # nothing to bench-verify
