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

from typing import Any

# An attempt must actually improve at least one measured dimension (score
# strictly above neutral) and regress neither to be eligible.
NEUTRAL = 0.5

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
        lines.append(f"Benchmark command: {constraints['benchCommand']}")
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
            feedback.append(f"'{title}': run {result.get('status', 'failed')}")
            continue
        ok, reason = _eligible(scorecard)
        if not ok:
            feedback.append(f"'{title}': {reason}")
    return feedback
