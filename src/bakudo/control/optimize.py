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

from ..performance.models import PerformanceComparison, RecordStatus, Verdict, WorkloadPin
from ..performance.revisions import sha256_text

# An attempt must actually improve at least one measured dimension (score
# strictly above neutral) and regress neither to be eligible. Performance is
# deliberately absent: only a trusted PerformanceComparison can establish it.
NEUTRAL = 0.5

# The callback receives ``AboxOutcome.diff`` unchanged. Its UTF-8 bytes (with
# no newline or Unicode normalization) define ``candidateRevision.patchDigest``
# via ``sha256_text``. It must provision that patch outside the agent's mutable
# tree, rerun the objective's already-pinned workload against fresh baseline/
# candidate environments, persist the resulting evidence, and return the typed
# comparison. Exceptions, malformed output, and lineage mismatches are local
# fail-closed rejections; they never make a candidate eligible.
PerformanceCompare = Callable[[str], PerformanceComparison]

# Suites that must be present and passing for an attempt to be eligible.
REQUIRED_PASSED_SUITES = ("schema", "safety", "task", "code")


def scout_objective(base: dict[str, Any], *, feedback: list[str] | None = None) -> dict[str, Any]:
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
    performance = base.get("performance") or {}
    workload_ref = performance.get("workloadRef") or {}
    if workload_ref:
        lines.append(
            "Pinned performance evidence: workload "
            f"{workload_ref.get('name')}@{workload_ref.get('version')}; primary metric "
            f"{performance.get('primaryMetric')}. Treat this as diagnostic context only. "
            "Do not attempt to inspect or mutate the privileged workload; Bakudo will "
            "measure candidates independently."
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


def attempt_objective(base: dict[str, Any], *, approach: str, index: int) -> dict[str, Any]:
    """Build one single-hypothesis attempt objective.

    One hypothesis per attempt keeps candidate diffs attributable when they
    are scored against their siblings.
    """
    constraints = dict(base.get("constraints", {}))
    description_lines = [
        f"Implement exactly this one optimization approach:\n{approach}",
        "Keep the full test suite green. Do not change public APIs unless the "
        "objective explicitly allows it. Bakudo will independently evaluate "
        "performance with the pinned workload after this run; do not report "
        "self-measured timing or complexity deltas as proof.",
    ]

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
    simplicity = suites.get("simplicity", NEUTRAL)
    if simplicity < NEUTRAL:
        return False, "regressed simplicity"
    return True, "eligible"


def _comparison(candidate: dict[str, Any]) -> PerformanceComparison | None:
    value = candidate.get("performance_comparison")
    if isinstance(value, PerformanceComparison):
        return value
    if isinstance(value, dict):
        try:
            return PerformanceComparison.model_validate(value)
        except ValueError:
            return None
    return None


def _comparison_rejection(
    comparison: PerformanceComparison,
    performance: dict[str, Any],
    *,
    candidate_diff: str,
) -> str | None:
    """Return why trusted evidence is ineligible, or ``None`` when it proves a win."""

    workload_ref = performance.get("workloadRef") or {}
    if comparison.workload.name != workload_ref.get("name"):
        return "comparison workload name does not match the objective"
    if comparison.workload.version != workload_ref.get("version"):
        return "comparison workload version does not match the objective"
    workload_pin = performance.get("workloadPin")
    if workload_pin is not None:
        try:
            expected_pin = WorkloadPin.model_validate(workload_pin)
        except ValueError:
            return "objective workload pin is invalid"
        if comparison.workload != expected_pin:
            return "comparison workload pin does not match the objective"
    if comparison.primary_metric != performance.get("primaryMetric"):
        return "comparison primary metric does not match the objective"
    policy = performance.get("decisionPolicy") or {}
    confidence = float(policy.get("confidence", 0.95))
    if comparison.confidence != confidence:
        return "comparison confidence does not match the objective policy"
    bootstrap_resamples = int(policy.get("bootstrapResamples", 10_000))
    if comparison.bootstrap_resamples != bootstrap_resamples:
        return "comparison bootstrap resamples do not match the objective policy"
    if comparison.candidate_revision.patch_digest != sha256_text(candidate_diff):
        return "comparison candidate patch digest does not match the captured diff"
    if (
        comparison.candidate_revision.repository != comparison.baseline_revision.repository
        or comparison.candidate_revision.base_commit_sha != comparison.baseline_revision.commit_sha
    ):
        return "comparison candidate revision is not based on the measured baseline"
    if comparison.status is not RecordStatus.completed:
        return f"comparison status is {comparison.status.value}"
    if comparison.verdict is not Verdict.improved:
        return f"comparison verdict is {comparison.verdict.value}"
    if (
        not comparison.integrity.valid
        or comparison.incompatibilities
        or comparison.allowed_differences
        or comparison.baseline_environment != comparison.candidate_environment
    ):
        return "comparison integrity or pin compatibility failed"

    metrics = {metric.metric_name: metric for metric in comparison.metrics}
    primary = metrics.get(comparison.primary_metric)
    if primary is None or not primary.valid:
        return "comparison primary metric is invalid"
    minimum = float(policy.get("minimumRelativeImprovement", 0.05))
    if (
        primary.relative_effect is None
        or primary.ci_lower is None
        or primary.relative_effect <= minimum
        or primary.ci_lower <= minimum
    ):
        return "comparison does not clear the objective's minimum improvement"
    for name in policy.get("protectedMetrics", []):
        metric = metrics.get(name)
        if metric is None or not metric.valid:
            return f"protected metric {name!r} is missing or invalid"
        if metric.verdict is Verdict.regressed:
            return f"protected metric {name!r} regressed"
    if not comparison.eligible:
        return "comparison is not eligible"
    return None


def select_winner(
    candidates: list[dict[str, Any]],
    *,
    performance: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    """Pick the best eligible attempt, or None when no safe improvement exists.

    Candidates are ``AgentRunOutput``-shaped dicts (``result``, ``scorecard``,
    ``git_branch``...). Eligibility is gated (behavior preservation is a hard
    gate, not a weighted score); eligible attempts are ranked by overall
    performance effect, then scorecard score, then smaller diff. Candidates
    without trusted comparison evidence are ineligible by construction.
    """
    if not performance:
        return None
    eligible: list[tuple[float, float, int, dict[str, Any]]] = []
    for candidate in candidates:
        scorecard = candidate.get("scorecard")
        result = candidate.get("result")
        if not scorecard or not result or result.get("status") != "success":
            continue
        ok, _ = _eligible(scorecard)
        if not ok:
            continue
        comparison = _comparison(candidate)
        if comparison is None:
            continue
        if (
            _comparison_rejection(
                comparison, performance, candidate_diff=candidate.get("diff") or ""
            )
            is not None
        ):
            continue
        primary = next(
            metric
            for metric in comparison.metrics
            if metric.metric_name == comparison.primary_metric
        )
        eligible.append(
            (
                float(primary.relative_effect or 0.0),
                float(scorecard.get("overall_score", 0.0)),
                -len(result.get("changed_files", [])),
                candidate,
            )
        )
    if not eligible:
        return None
    eligible.sort(key=lambda entry: (entry[0], entry[1], entry[2]), reverse=True)
    return eligible[0][3]


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
            continue
        comparison = _comparison(candidate)
        if comparison is None:
            feedback.append(f"'{title}': independent performance comparison unavailable")
    return feedback


# --- in-process loop driver (CLI/API; mirrors OptimizationWorkflow) ---


def load_role_spec(name: str, path: str | None = None) -> Any:
    """Load a seed AgentSpec by role name, or from an explicit path."""
    from pathlib import Path

    from ..agent_spec import load_spec_file
    from ..paths import agents_dir

    spec_path = Path(path) if path else agents_dir() / f"{name}.yaml"
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
    performance_compare: PerformanceCompare | None = None,
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
                Objective.model_validate(attempt_objective(base, approach=approach, index=index)),
                attempt_spec,
                ledger=ledger,
                sandbox=sandbox,
            )
            candidates.append(
                {
                    "run_id": attempt.run_id,
                    "git_branch": attempt.outcome.git_branch,
                    # The agent branch does not survive sandbox cleanup. The
                    # exact captured diff is therefore the candidate artifact
                    # bound into independent measurement evidence.
                    "diff": attempt.outcome.diff,
                    "error": attempt.outcome.error or attempt.outcome.stderr[-500:],
                    "result": attempt.result.to_dict() if attempt.result else None,
                    "scorecard": (
                        attempt.scorecard.model_dump(mode="json") if attempt.scorecard else None
                    ),
                }
            )

        winner, verify_feedback = _compared_winner(
            candidates,
            base.get("performance") or {},
            performance_compare,
        )
        if winner is not None:
            return {
                "status": "improved",
                "rounds_used": rounds,
                "winner_run_id": winner.get("run_id"),
                "git_branch": winner.get("git_branch"),
                "scorecard": winner.get("scorecard"),
                "result": winner.get("result"),
                "performance_comparison": winner.get("performance_comparison"),
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


def _compared_winner(
    candidates: list[dict[str, Any]],
    performance: dict[str, Any],
    performance_compare: PerformanceCompare | None,
) -> tuple[dict[str, Any] | None, list[str]]:
    """Measure every behaviorally eligible candidate, then select by trusted evidence."""

    verify_feedback: list[str] = []
    for candidate in candidates:
        scorecard = candidate.get("scorecard")
        result = candidate.get("result") or {}
        ok, _reason = _eligible(scorecard) if scorecard else (False, "missing scorecard")
        if result.get("status") != "success" or not ok:
            continue
        title = (result.get("summary") or "attempt")[:120]
        diff = candidate.get("diff") or ""
        if not diff.strip():
            verify_feedback.append(f"'{title}': candidate produced no patch to measure")
            continue
        if performance_compare is None:
            verify_feedback.append(f"'{title}': independent performance comparison unavailable")
            continue
        try:
            returned = performance_compare(diff)
            comparison = (
                returned
                if isinstance(returned, PerformanceComparison)
                else PerformanceComparison.model_validate(returned)
            )
            serialized = comparison.to_dict()
            rejection = _comparison_rejection(comparison, performance, candidate_diff=diff)
        except Exception as exc:  # noqa: BLE001 - measurement failure is typed feedback
            verify_feedback.append(f"'{title}': independent performance comparison failed: {exc}")
            continue
        candidate["performance_comparison"] = serialized
        if rejection is not None:
            verify_feedback.append(f"'{title}': {rejection}")
    return select_winner(candidates, performance=performance), verify_feedback
