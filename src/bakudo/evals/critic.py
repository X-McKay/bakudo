"""Critic eval: a sandboxed review agent scores a run's diff (design §5, OPT-8).

Per spec §9.1/§21 ("did a review agent find serious issues?"), ``critic_eval``
runs the ``critic`` role as a *real read-only agent* through the same sandbox
driver abstraction the pipeline uses — production is AboxRunner-backed, tests
inject a fake driver returning a canned verdict. The candidate's diff and
branch ride in the critic objective as the review target.

The critic's result contract is the pinned verdict ``{score: 0..1, passed:
bool, issues: [str]}`` (``agents/critic.yaml``), subsumed into the standard
``result.json`` envelope: ``metrics.score`` (0..1), ``metrics.passed``
(1 or 0 — the schema's metrics are numeric), and each issue as an entry in
``proposedFollowups``.

Failure semantics (no silent pass, no fabricated abstention):

* sandbox failure or verdict/schema failure -> the critic suite ERRORS
  (``passed=False, score=0.0, details.errored``);
* no sandbox available (offline/dev) -> ``None``: the suite is omitted from
  the scorecard, and a promotion policy that *requires* ``critic`` then fails
  loudly with ``missing required suite``.
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import TYPE_CHECKING, Any

from .. import ids
from .checks import EvalContext
from .result import EvalResult

if TYPE_CHECKING:  # pragma: no cover - typing only
    from ..agent_spec import AgentSpec
    from ..bundle import TaskBundle

# The same driver signature the pipeline/activities use.
SandboxFn = Callable[["TaskBundle"], Any]

# How much of the candidate diff is embedded in the review objective.
_MAX_DIFF_CHARS = 12_000


def _load_critic_spec() -> AgentSpec:
    from ..agent_spec import load_spec_file

    return load_spec_file(
        Path(__file__).resolve().parents[3] / "agents" / "critic.yaml"
    )


def _review_objective(ctx: EvalContext):
    """The critic objective: candidate diff/branch as the review target."""
    from ..curriculum.objective import Objective

    branch = ids.git_branch_for(ctx.result.run_id)
    description = "\n".join(
        [
            f"Review the candidate change from run {ctx.result.run_id} "
            f"(branch {branch}).",
            f"Original objective: {ctx.objective.title}",
            f"Acceptance criteria: {ctx.objective.acceptance_criteria}",
            f"Candidate summary: {ctx.result.summary}",
            f"Changed files: {ctx.result.changed_files}",
            "Diff under review:",
            ctx.diff[:_MAX_DIFF_CHARS],
        ]
    )
    return Objective.model_validate(
        {
            "id": ids.objective_id(),
            "type": "critic",
            "repo": ctx.objective.repo,
            "title": f"Review run {ctx.result.run_id}",
            "description": description,
            "acceptanceCriteria": [
                "Report the pinned verdict: metrics.score (0..1), "
                "metrics.passed (1 or 0), issues as proposedFollowups",
            ],
        }
    )


def _extract_verdict(result: dict) -> dict | None:
    """Pull the pinned verdict out of a critic run's result.json envelope."""
    metrics = result.get("metrics") or {}
    if "score" not in metrics or "passed" not in metrics:
        return None
    issues = [
        str(item)
        for item in (result.get("proposed_followups") or [])
    ]
    return {
        "score": float(metrics["score"]),
        "passed": bool(metrics["passed"]),
        "issues": issues,
    }


def _errored(ctx: EvalContext, error: str) -> EvalResult:
    """The critic suite ERRORS: a hard fail, never a silent pass."""
    return EvalResult(
        subject_type="run",
        subject_id=ctx.result.run_id,
        suite_name="critic",
        score=0.0,
        passed=False,
        details={"errored": True, "error": error},
    )


def critic_eval(
    ctx: EvalContext,
    sandbox: SandboxFn | None = None,
    *,
    spec: AgentSpec | None = None,
) -> EvalResult | None:
    """Review one run with a sandboxed critic agent.

    Returns ``None`` when no sandbox driver is available (the suite is
    omitted); otherwise always returns an EvalResult — a verdict grade or an
    ERRORED suite on any sandbox/schema failure.
    """
    if sandbox is None:
        return None

    from ..bundle import TaskBundle, budget_from_spec

    critic_spec = spec or _load_critic_spec()
    objective = _review_objective(ctx)
    bundle = TaskBundle(
        run_id=ids.run_id(),
        objective_id=objective.id,
        objective=objective,
        agent_spec=critic_spec,
        budget=budget_from_spec(critic_spec),
    )

    try:
        outcome = sandbox(bundle)
    except Exception as exc:  # noqa: BLE001 - any driver failure is an ERROR
        return _errored(ctx, f"critic sandbox failed: {type(exc).__name__}: {exc}")

    result = getattr(outcome, "result", None)
    if not getattr(outcome, "succeeded", False) or not isinstance(result, dict):
        detail = getattr(outcome, "error", "") or "sandbox produced no result"
        if isinstance(result, dict) and result.get("summary"):
            # Surface the inner run's own diagnosis — "sandbox produced no
            # result" alone hides the actionable failure (observed live).
            detail = f"{detail}: {result['summary'][:300]}"
        return _errored(ctx, f"critic run failed: {detail}")

    verdict = _extract_verdict(result)
    if verdict is None:
        return _errored(
            ctx,
            "critic result.json carries no verdict "
            "(metrics.score/metrics.passed missing)",
        )

    issues = verdict["issues"]
    return EvalResult(
        subject_type="run",
        subject_id=ctx.result.run_id,
        suite_name="critic",
        score=max(0.0, min(1.0, verdict["score"])),
        passed=verdict["passed"],
        details={
            "issues": issues,
            "issue_count": len(issues),
            "critic_run_id": bundle.run_id,
        },
    )
