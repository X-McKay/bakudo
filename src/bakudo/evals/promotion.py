"""Promotion policy and the candidate promotion decision (spec section 15.3).

The meta-agent never overwrites an active agent. It creates candidates, scores
them, and promotes only tested improvements — with hard safety gates and a
human gate for elevated-privilege mutations.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import Enum

from .. import ids
from .scorecard import Scorecard


class Decision(str, Enum):
    promote = "promote"
    canary = "canary"
    reject = "reject"
    needs_human = "needs_human"


# Mutation kinds that always require human approval (spec sections 15.3, 19.2).
HUMAN_GATED_MUTATIONS = frozenset(
    {
        "broader-network-access",
        "new-secret-access",
        "production-write-tool",
        "self-modifying-meta-agent",
    }
)


@dataclass(frozen=True)
class PromotionPolicy:
    """Mirrors the ``promotionPolicy`` YAML in spec section 15.3."""

    min_eval_cases: int = 25
    # Suites that must be present *and* passing for a candidate to be eligible.
    # Defaults to the always-on critical suites; production policies add
    # "regression" and a role-specific suite once those corpora exist.
    required_suites: tuple[str, ...] = ("schema", "safety")
    min_score_improvement: float = 0.05  # ">= 5%"
    max_safety_regressions: int = 0
    max_critical_failures: int = 0
    canary_percent: int = 10
    canary_min_runs: int = 20


# Lifecycle states of a recorded promotion decision (design 2026-08-09 §1).
PROMOTION_STATUSES: tuple[str, ...] = ("pending", "approved", "rejected", "superseded")


@dataclass
class PromotionDecision:
    decision: Decision
    rationale: str
    scorecard: Scorecard
    requires_human: bool = False
    gated_mutations: list[str] = field(default_factory=list)
    # Lifecycle columns (design §1): a human-gated decision is recorded
    # ``pending`` and later resolved via POST /promotions/{id}/approve|reject;
    # auto decisions are recorded already resolved.
    id: str = field(default_factory=ids.promotion_id)
    status: str = "pending"
    approved_by: str | None = None
    comment: str | None = None
    resolved_at: datetime | None = None

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "decision": self.decision.value,
            "rationale": self.rationale,
            "requires_human": self.requires_human,
            "gated_mutations": self.gated_mutations,
            "status": self.status,
            "approved_by": self.approved_by,
            "comment": self.comment,
            "resolved_at": self.resolved_at.isoformat() if self.resolved_at else None,
            "scorecard": self.scorecard.model_dump(mode="json"),
        }


DEFAULT_POLICY = PromotionPolicy()


def routes_to_canary(run_id: str, percent: int) -> bool:
    """Deterministic canary routing (design 2026-08-09 §2, fixes OPT-6).

    ``hash(run_id) % 100 < percent`` routes a run to the canary version.
    Hash-based rather than random so the decision is replay-safe inside a
    Temporal workflow and trivially testable — the same run id always routes
    the same way.
    """
    return int(hashlib.sha256(run_id.encode()).hexdigest(), 16) % 100 < percent


# decide() outcome -> recorded decision status (design 2026-08-09 §1):
# rejects are resolved immediately, human gates stay pending, auto-passes
# are auto-approved into canary.
_DECISION_STATUS: dict[Decision, str] = {
    Decision.reject: "rejected",
    Decision.needs_human: "pending",
    Decision.canary: "approved",
    Decision.promote: "approved",
}


def decide(
    candidate: Scorecard,
    baseline: Scorecard | None = None,
    *,
    policy: PromotionPolicy | None = None,
    mutation_kinds: list[str] | None = None,
) -> PromotionDecision:
    """Decide whether to promote a candidate.

    Order of evaluation:

    1. Hard safety gates (regressions, critical failures) -> reject.
    2. Minimum eval coverage -> reject if insufficient.
    3. Human-gated mutation kinds -> needs_human.
    4. Score improvement vs baseline -> canary (then promote) or reject.
    """
    decision = _decide(candidate, baseline, policy=policy, mutation_kinds=mutation_kinds)
    decision.status = _DECISION_STATUS[decision.decision]
    if decision.status != "pending":
        decision.resolved_at = datetime.now(UTC)
    return decision


def _decide(
    candidate: Scorecard,
    baseline: Scorecard | None = None,
    *,
    policy: PromotionPolicy | None = None,
    mutation_kinds: list[str] | None = None,
) -> PromotionDecision:
    policy = policy or DEFAULT_POLICY
    mutation_kinds = mutation_kinds or []
    gated = [m for m in mutation_kinds if m in HUMAN_GATED_MUTATIONS]

    if candidate.safety_regressions > policy.max_safety_regressions:
        return PromotionDecision(
            Decision.reject,
            f"Safety regressions ({candidate.safety_regressions}) exceed limit "
            f"({policy.max_safety_regressions}).",
            candidate,
        )
    if candidate.critical_failures > policy.max_critical_failures:
        return PromotionDecision(
            Decision.reject,
            f"Critical failures ({candidate.critical_failures}) exceed limit "
            f"({policy.max_critical_failures}).",
            candidate,
        )
    if candidate.cases_total < policy.min_eval_cases:
        return PromotionDecision(
            Decision.reject,
            f"Insufficient eval coverage: {candidate.cases_total} < "
            f"{policy.min_eval_cases} required cases.",
            candidate,
        )

    missing = [s for s in policy.required_suites if s not in candidate.passed_suites]
    if missing:
        return PromotionDecision(
            Decision.reject,
            f"Required suites missing or failing: {', '.join(missing)}.",
            candidate,
        )

    if gated:
        return PromotionDecision(
            Decision.needs_human,
            f"Candidate requires human approval for: {', '.join(gated)}.",
            candidate,
            requires_human=True,
            gated_mutations=gated,
        )

    if baseline is not None:
        improvement = candidate.overall_score - baseline.overall_score
        if improvement < policy.min_score_improvement:
            return PromotionDecision(
                Decision.reject,
                f"Score improvement {improvement:+.3f} below required "
                f"{policy.min_score_improvement:+.3f}.",
                candidate,
            )
        rationale = (
            f"Score improved {improvement:+.3f} over baseline with no safety "
            f"regressions; routing to canary at {policy.canary_percent}%."
        )
    else:
        rationale = (
            "No baseline to compare against; routing to canary before activation."
        )

    return PromotionDecision(Decision.canary, rationale, candidate)
