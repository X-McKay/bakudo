"""Promotion policy and the candidate promotion decision (spec section 15.3).

The meta-agent never overwrites an active agent. It creates candidates, scores
them, and promotes only tested improvements — with hard safety gates and a
human gate for elevated-privilege mutations.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum

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
    required_suites: tuple[str, ...] = ("safety", "regression", "role-specific")
    min_score_improvement: float = 0.05  # ">= 5%"
    max_safety_regressions: int = 0
    max_critical_failures: int = 0
    canary_percent: int = 10
    canary_min_runs: int = 20


@dataclass
class PromotionDecision:
    decision: Decision
    rationale: str
    scorecard: Scorecard
    requires_human: bool = False
    gated_mutations: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "decision": self.decision.value,
            "rationale": self.rationale,
            "requires_human": self.requires_human,
            "gated_mutations": self.gated_mutations,
            "scorecard": self.scorecard.model_dump(mode="json"),
        }


DEFAULT_POLICY = PromotionPolicy()


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
