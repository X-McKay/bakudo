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

from collections.abc import Awaitable, Callable, Iterable
from typing import Any

# An attempt must actually improve at least one measured dimension (score
# strictly above neutral) and regress neither to be eligible.
NEUTRAL = 0.5

# Suites that must be present and passing for an attempt to be eligible.
REQUIRED_PASSED_SUITES = ("schema", "safety", "sandbox", "task", "code")


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
        "objective explicitly allows it. The harness measures the benchmark "
        "and complexity itself, before and after your change — self-reported "
        "numbers are ignored, so verify your change actually helps before "
        "finishing.",
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


# --- the shared round driver ---

# A role runner takes an objective document and yields an AgentRunOutput-shaped
# dict. The gather callable awaits a batch of attempt coroutines — asyncio.gather
# in the Temporal workflow (parallel child workflows), sequential in-process
# awaiting in the CLI loop.
RunRole = Callable[[dict[str, Any]], Awaitable[dict[str, Any]]]
GatherFn = Callable[..., Awaitable[Iterable[dict[str, Any]]]]
OnPhase = Callable[[int, str], None]


async def drive_optimize(
    base: dict[str, Any],
    *,
    run_scout: RunRole,
    run_attempt: RunRole,
    gather: GatherFn,
    max_rounds: int = 2,
    max_approaches: int = 3,
    on_phase: OnPhase | None = None,
) -> dict[str, Any]:
    """The scout -> attempts -> selection round loop, shared by both drivers.

    :class:`~bakudo.temporal.workflows.OptimizationWorkflow` and
    :func:`run_optimize_loop` differ only in how they execute a role run and
    how they await a batch — the round logic, gates, and outcome shapes live
    here exactly once. Deterministic (no I/O, no clock), so it is safe inside
    the Temporal workflow sandbox.
    """
    notify = on_phase or (lambda _round, _phase: None)
    feedback: list[str] = []
    rounds = 0

    while rounds < max_rounds:
        rounds += 1

        notify(rounds, "scouting")
        scout = await run_scout(scout_objective(base, feedback=feedback))
        scout_result = scout.get("result") or {}
        approaches = list(scout_result.get("proposed_followups", []))[:max_approaches]
        if not approaches:
            # The scout found nothing worth trying — a valid outcome.
            notify(rounds, "no-change")
            return {
                "status": "no-change",
                "rounds_used": rounds,
                "reason": "scout proposed no approaches",
            }

        notify(rounds, "attempting")
        attempts = list(
            await gather(
                *(
                    run_attempt(attempt_objective(base, approach=a, index=i))
                    for i, a in enumerate(approaches)
                )
            )
        )

        notify(rounds, "selecting")
        winner = select_winner(attempts)
        if winner is not None:
            notify(rounds, "improved")
            return {
                "status": "improved",
                "rounds_used": rounds,
                "winner_run_id": winner.get("run_id"),
                "git_branch": winner.get("git_branch"),
                "scorecard": winner.get("scorecard"),
                "result": winner.get("result"),
            }
        feedback = round_feedback(attempts)

    notify(rounds, "no-change")
    return {
        "status": "no-change",
        "rounds_used": rounds,
        "reason": "no attempt cleared the gates",
        "feedback": feedback,
    }


# --- in-process loop driver (CLI/API; thin shell over drive_optimize) ---


def load_role_spec(name: str, path: str | None = None) -> Any:
    """Load a seed AgentSpec by role name, or from an explicit path."""
    from pathlib import Path

    from ..agent_spec import load_spec_file
    from ..paths import agents_dir

    spec_path = Path(path) if path else agents_dir() / f"{name}.yaml"
    return load_spec_file(spec_path)


def run_optimize_loop(
    objective: Any,
    scout_spec: Any,
    attempt_spec: Any,
    *,
    max_rounds: int = 2,
    max_approaches: int = 3,
    ledger: Any = None,
    sandbox: Any = None,
) -> dict[str, Any]:
    """Run the scout → attempts → selection loop in-process.

    The synchronous shell over :func:`drive_optimize` (the same relationship
    ``run_objective`` has to ``AgentRunWorkflow``): identical round logic and
    gates, sequential attempts instead of parallel child workflows. Used by
    the CLI and the v0.1 control API; production submits the Temporal
    workflow instead.
    """
    import asyncio

    from ..curriculum.objective import Objective
    from ..registry import InMemoryLedger
    from .pipeline import run_objective

    ledger = ledger or InMemoryLedger()

    async def run_role(objective_doc: dict[str, Any], spec: Any) -> dict[str, Any]:
        pipeline = run_objective(
            Objective.model_validate(objective_doc), spec, ledger=ledger, sandbox=sandbox
        )
        return {
            "run_id": pipeline.run_id,
            "git_branch": pipeline.outcome.git_branch,
            "result": pipeline.result.to_dict() if pipeline.result else None,
            "scorecard": (
                pipeline.scorecard.model_dump(mode="json") if pipeline.scorecard else None
            ),
        }

    async def gather_sequential(*coros: Any) -> list[dict[str, Any]]:
        return [await coro for coro in coros]

    return asyncio.run(
        drive_optimize(
            objective.to_dict(),
            run_scout=lambda doc: run_role(doc, scout_spec),
            run_attempt=lambda doc: run_role(doc, attempt_spec),
            gather=gather_sequential,
            max_rounds=max_rounds,
            max_approaches=max_approaches,
        )
    )
