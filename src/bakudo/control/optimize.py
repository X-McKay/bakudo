"""Pure orchestration logic for the optimization loop (spec sections 11, 15).

The :class:`~bakudo.temporal.workflows.OptimizationWorkflow` fans one
``optimize`` objective out into a read-only scout run, N parallel single-
hypothesis attempt runs, and a winner selection — looping with feedback until
a candidate clears the gates or the round budget is spent. Everything here is
deterministic and dict-shaped so it can run inside the Temporal workflow
sandbox and be unit-tested without a worker.

"No safe improvement found" is a *success* outcome: the selection gates must
reject churn, and the corpus rewards leaving already-optimal code untouched.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

# An attempt must actually improve at least one measured dimension (score
# strictly above neutral) and regress neither to be eligible.
NEUTRAL = 0.5

# Issue #28 (OPT-3): the minimum *independently measured* fractional speedup
# for a winner's benchmark claim to count as reproduced. Wall-clock timing of
# the whole bench command carries interpreter-startup noise, so this floor is
# deliberately above perf_eval's PERF_NOISE_TOLERANCE.
BENCH_VERIFY_MIN_IMPROVEMENT = 0.05

# Independent measurement hook: (winner_diff, bench_command) ->
# (measured_before_seconds, measured_after_seconds). Injected so the loop
# logic stays pure; the live implementation runs both benches in a fresh
# sandbox (never host-side — the diff is model-authored code).
BenchMeasure = Callable[[str, str], tuple[float, float]]

# Suites that must be present and passing for an attempt to be eligible.
REQUIRED_PASSED_SUITES = ("schema", "safety", "task", "code")


def scout_objective(
    base: dict[str, Any], *, feedback: list[str] | None = None
) -> dict[str, Any]:
    """Build the read-only scout objective for one round.

    The scout inherits the optimize objective's repo/targets and returns its
    approaches as ``proposed_followups`` — one hypothesis per entry. Prior
    rounds' failure feedback is appended so round N+1 avoids round N's dead
    ends.
    """
    lines = [base.get("description", "")]
    constraints = base.get("constraints", {})
    if constraints.get("targetPaths"):
        lines.append(f"Target paths: {', '.join(constraints['targetPaths'])}")
    if constraints.get("benchCommand"):
        # The scout's read-only policy denies the bench; advertising it as
        # runnable burned policy denials in every live cycle.
        lines.append(
            f"Benchmark command (context only — your read-only policy denies "
            f"it, do NOT run it; the attempt agents will): "
            f"{constraints['benchCommand']}"
        )
    lines.append(
        "Propose up to N distinct optimization approaches as proposedFollowups, "
        "one hypothesis per entry: what to change, the expected effect "
        "(performance, simplicity, or idiom), and how to verify it. Do not "
        "modify any files. If the code is already well-optimized, return an "
        "empty proposedFollowups list — that is a valid, successful outcome."
    )
    if feedback:
        lines.append("Previous rounds failed with: " + " | ".join(feedback))

    return {
        **base,
        "type": "explore",
        "title": f"[optimize-scout] {base.get('title', '')}",
        "description": "\n".join(line for line in lines if line),
        "suggestedAgents": ["optimize-scout"],
    }


def attempt_objective(
    base: dict[str, Any], *, approach: str, index: int
) -> dict[str, Any]:
    """Build one single-hypothesis attempt objective.

    One hypothesis per attempt keeps candidate diffs attributable when they
    are scored against their siblings.
    """
    constraints = dict(base.get("constraints", {}))
    description_lines = [
        f"Implement exactly this one optimization approach:\n{approach}",
        "Keep the full test suite green. Do not change public APIs unless the "
        "objective explicitly allows it. Report bench_seconds_before/"
        "bench_seconds_after (run the benchmark command before and after your "
        "change) and complexity_before/complexity_after in result.json "
        "metrics.",
    ]
    if constraints.get("benchCommand"):
        description_lines.append(f"Benchmark command: {constraints['benchCommand']}")

    return {
        **base,
        "type": "optimize",
        "title": f"[optimize-attempt {index + 1}] {base.get('title', '')}",
        "description": "\n".join(description_lines),
        "constraints": constraints,
        "suggestedAgents": ["optimize-attempt"],
    }


def scout_run_failed(scout: dict[str, Any]) -> bool:
    """True when a scout run must be treated as a *failure* (OPT-12, #27).

    Failed phase/result or a missing result are failures. So is a ``blocked``
    result with no ``proposed_followups``: the scout was halted (budget,
    tool-call ceiling, denial breaker) before delivering hypotheses, which
    must never masquerade as the "code is already optimal" success outcome.
    A blocked scout that still delivered followups is usable. Shared by both
    loop mirrors (``run_optimize_loop`` and ``OptimizationWorkflow``).
    """
    result = scout.get("result") or {}
    if scout.get("phase") == "failed" or not result:
        return True
    status = result.get("status")
    if status == "failed":
        return True
    return status == "blocked" and not result.get("proposed_followups")


def _eligible(scorecard: dict[str, Any]) -> tuple[bool, str]:
    """Apply the hard gates to one attempt's scorecard."""
    if scorecard.get("safety_regressions", 0) > 0:
        return False, "safety regression"
    if scorecard.get("critical_failures", 0) > 0:
        return False, "critical failure"
    passed = set(scorecard.get("passed_suites", []))
    missing = [s for s in REQUIRED_PASSED_SUITES if s not in passed]
    if missing:
        return False, f"failed suites: {', '.join(missing)}"

    suites = scorecard.get("suites", {})
    perf = suites.get("perf", NEUTRAL)
    simplicity = suites.get("simplicity", NEUTRAL)
    if perf < NEUTRAL or simplicity < NEUTRAL:
        return False, "regressed perf or simplicity"
    if perf <= NEUTRAL and simplicity <= NEUTRAL:
        return False, "no measured improvement"
    return True, "eligible"


def bench_reproduces(measured_before: float, measured_after: float) -> tuple[bool, str]:
    """Judge an independent bench measurement (issue #28, OPT-3).

    The winner's *claimed* speedup is irrelevant here: selection already
    gated on it. What must hold is that the measured run shows a real
    improvement at all — otherwise the claim did not reproduce.
    """
    if measured_before <= 0:
        return False, f"invalid measured baseline {measured_before!r}"
    improvement = (measured_before - measured_after) / measured_before
    detail = (
        f"measured {measured_before:.4f}s -> {measured_after:.4f}s "
        f"({improvement:+.0%})"
    )
    if improvement > BENCH_VERIFY_MIN_IMPROVEMENT:
        return True, detail
    return False, f"{detail}: claimed speedup did not reproduce"


def select_winner(candidates: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Pick the best eligible attempt, or None when no safe improvement exists.

    Candidates are ``AgentRunOutput``-shaped dicts (``result``, ``scorecard``,
    ``git_branch``...). Eligibility is gated (behavior preservation is a hard
    gate, not a weighted score); eligible attempts are ranked by overall
    scorecard score, ties broken by smaller diff (fewer changed files).
    """
    eligible: list[tuple[float, int, dict[str, Any]]] = []
    for candidate in candidates:
        scorecard = candidate.get("scorecard")
        result = candidate.get("result")
        if not scorecard or not result or result.get("status") != "success":
            continue
        ok, _ = _eligible(scorecard)
        if not ok:
            continue
        eligible.append(
            (
                float(scorecard.get("overall_score", 0.0)),
                -len(result.get("changed_files", [])),
                candidate,
            )
        )
    if not eligible:
        return None
    eligible.sort(key=lambda entry: (entry[0], entry[1]), reverse=True)
    return eligible[0][2]


def round_feedback(candidates: list[dict[str, Any]]) -> list[str]:
    """Summarise why each attempt failed, as context for the next scout round."""
    feedback: list[str] = []
    for candidate in candidates:
        result = candidate.get("result") or {}
        scorecard = candidate.get("scorecard")
        title = (result.get("summary") or "attempt")[:120]
        if not scorecard or result.get("status") != "success":
            # Surface the sandbox error for result-less runs — 'run failed'
            # alone made live cycles undiagnosable.
            detail = (candidate.get("error") or "")[-200:]
            feedback.append(
                f"'{title}': run {result.get('status', 'failed')}"
                + (f" ({detail})" if detail else "")
            )
            continue
        ok, reason = _eligible(scorecard)
        if not ok:
            feedback.append(f"'{title}': {reason}")
    return feedback


# --- in-process loop driver (CLI/API; mirrors OptimizationWorkflow) ---


def load_role_spec(name: str, path: str | None = None) -> Any:
    """Load a seed AgentSpec by role name, or from an explicit path."""
    from pathlib import Path

    from ..agent_spec import load_spec_file

    spec_path = (
        Path(path)
        if path
        else Path(__file__).resolve().parents[3] / "agents" / f"{name}.yaml"
    )
    return load_spec_file(spec_path)


def _scout_failed(scout: Any) -> bool:
    """Attr-shaped adapter over :func:`scout_run_failed` for pipeline results."""
    phase = getattr(scout, "phase", None)
    result = getattr(scout, "result", None)
    return scout_run_failed(
        {
            "phase": getattr(phase, "value", phase),
            "result": result.to_dict() if result is not None else None,
        }
    )


def run_optimize_loop(
    objective: Any,
    scout_spec: Any,
    attempt_spec: Any,
    *,
    max_rounds: int = 2,
    max_approaches: int = 3,
    ledger: Any = None,
    sandbox: Any = None,
    bench_measure: BenchMeasure | None = None,
) -> dict[str, Any]:
    """Run the scout → attempts → selection loop in-process.

    The synchronous mirror of ``OptimizationWorkflow`` (the same relationship
    ``run_objective`` has to ``AgentRunWorkflow``): identical round logic and
    gates, sequential attempts instead of parallel child workflows. Used by
    the CLI and the v0.1 control API; production submits the Temporal
    workflow instead.
    """
    from ..curriculum.objective import Objective
    from ..registry import InMemoryLedger
    from .pipeline import run_objective

    ledger = ledger or InMemoryLedger()
    base = objective.to_dict()
    feedback: list[str] = []
    rounds = 0

    while rounds < max_rounds:
        rounds += 1

        scout = run_objective(
            Objective.model_validate(scout_objective(base, feedback=feedback)),
            scout_spec,
            ledger=ledger,
            sandbox=sandbox,
        )
        if _scout_failed(scout):
            # One retry: scout failures are usually transient (model hiccup,
            # output truncation), and losing the whole cycle to one is wasteful.
            scout = run_objective(
                Objective.model_validate(scout_objective(base, feedback=feedback)),
                scout_spec,
                ledger=ledger,
                sandbox=sandbox,
            )
        if _scout_failed(scout):
            # OPT-12: infrastructure/model failure must never masquerade as the
            # "code is already optimal" success outcome.
            summary = scout.result.summary if scout.result else "no result collected"
            return {
                "status": "scout-failed",
                "rounds_used": rounds,
                "reason": f"scout run failed: {summary}",
            }
        followups = scout.result.proposed_followups if scout.result else []
        approaches = list(followups)[:max_approaches]
        if not approaches:
            return {
                "status": "no-change",
                "rounds_used": rounds,
                "reason": "scout proposed no approaches",
            }

        candidates: list[dict[str, Any]] = []
        for index, approach in enumerate(approaches):
            attempt = run_objective(
                Objective.model_validate(
                    attempt_objective(base, approach=approach, index=index)
                ),
                attempt_spec,
                ledger=ledger,
                sandbox=sandbox,
            )
            candidates.append(
                {
                    "run_id": attempt.run_id,
                    "git_branch": attempt.outcome.git_branch,
                    # The agent branch does not survive sandbox cleanup, so the
                    # collected diff is the only re-benchable artifact (#28).
                    "diff": attempt.outcome.diff,
                    "error": attempt.outcome.error or attempt.outcome.stderr[-500:],
                    "result": attempt.result.to_dict() if attempt.result else None,
                    "scorecard": (
                        attempt.scorecard.model_dump(mode="json")
                        if attempt.scorecard
                        else None
                    ),
                }
            )

        bench_cmd = base.get("constraints", {}).get("benchCommand")
        winner, verified, verify_feedback = _verified_winner(
            candidates, bench_cmd, bench_measure
        )
        if winner is not None:
            return {
                "status": "improved",
                "rounds_used": rounds,
                "winner_run_id": winner.get("run_id"),
                "git_branch": winner.get("git_branch"),
                "scorecard": winner.get("scorecard"),
                "result": winner.get("result"),
                "bench_verified": verified,
            }
        # Accumulate across rounds (OPT-17): round N+1's scout must still see
        # round 1's dead ends, or it can re-propose them.
        feedback = feedback + round_feedback(candidates) + verify_feedback

    return {
        "status": "no-change",
        "rounds_used": rounds,
        "reason": "no attempt cleared the gates",
        "feedback": feedback,
    }


def _verified_winner(
    candidates: list[dict[str, Any]],
    bench_command: str | None,
    bench_measure: BenchMeasure | None,
) -> tuple[dict[str, Any] | None, bool, list[str]]:
    """Select a winner, independently re-benching each pick (issue #28).

    A candidate whose claimed speedup does not reproduce is rejected (with
    feedback for the next scout round) and selection falls through to the
    next eligible attempt. Without a bench command or measurer there is
    nothing to verify: selection proceeds as before, marked unverified.
    """
    remaining = list(candidates)
    verify_feedback: list[str] = []
    while True:
        winner = select_winner(remaining)
        if winner is None:
            return None, False, verify_feedback
        if not bench_command or bench_measure is None:
            return winner, False, verify_feedback
        try:
            measured_before, measured_after = bench_measure(
                winner.get("diff") or "", bench_command
            )
            ok, detail = bench_reproduces(measured_before, measured_after)
        except Exception as exc:  # noqa: BLE001 - a broken bench must not crash the loop
            ok, detail = False, f"bench verification errored: {exc}"
        if ok:
            return winner, True, verify_feedback
        title = ((winner.get("result") or {}).get("summary") or "attempt")[:120]
        verify_feedback.append(
            f"'{title}': failed independent bench verification: {detail}"
        )
        remaining = [c for c in remaining if c is not winner]
