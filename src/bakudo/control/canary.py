"""Automated canary scheduling (spec §15.3) — register, route, observe, decide.

The full lifecycle a canaried candidate moves through, with no manual step:

1. **Register** — an evolution decision of ``canary`` records the candidate
   spec with status ``canary`` (:func:`register_canary`).
2. **Route** — at dispatch, :func:`route_version` sends a deterministic
   ``canary_percent`` slice of an agent's traffic to the canary version (a
   stable hash of the objective id, so replays route identically).
3. **Observe** — after every completed run, :func:`observe_canary` rebuilds
   the canaried runs' scorecards from the ledger's eval results.
4. **Decide** — once ``canary_min_runs`` runs are observed,
   :func:`~bakudo.evals.promotion.evaluate_canary` promotes (canary becomes
   the active version, the old active is archived) or rolls back (canary
   archived). Still-observing returns ``None`` and records nothing.
"""

from __future__ import annotations

import zlib
from statistics import mean

from ..agent_spec import AgentSpec, dump_yaml
from ..evals.promotion import Decision, PromotionDecision, PromotionPolicy, evaluate_canary
from ..evals.scorecard import Scorecard
from ..log import get_logger
from ..registry.ledger import Ledger
from ..registry.records import AgentVersionRecord

log = get_logger(__name__)

DEFAULT_POLICY = PromotionPolicy()


def register_canary(ledger: Ledger, spec: AgentSpec) -> AgentVersionRecord:
    """Record a candidate spec as the canary version of its agent."""
    record = AgentVersionRecord(
        name=spec.metadata.name,
        version=spec.metadata.version,
        spec_yaml=dump_yaml(spec),
        status="canary",
        parent_version=spec.metadata.parent_version,
    )
    log.info(
        "canary registered",
        extra={"context": {"agent": spec.ref, "parent": spec.metadata.parent_version}},
    )
    return ledger.upsert_agent_version(record)


def routing_percent(routing_key: str) -> int:
    """A stable 0..99 bucket for a routing key (crc32, not PYTHONHASHSEED)."""
    return zlib.crc32(routing_key.encode("utf-8")) % 100


def route_version(
    ledger: Ledger,
    name: str,
    routing_key: str,
    *,
    policy: PromotionPolicy = DEFAULT_POLICY,
) -> AgentVersionRecord | None:
    """Pick the version a dispatch should run: canary slice or active.

    Deterministic in the routing key so a Temporal replay routes the same
    objective to the same version.
    """
    canary = ledger.canary_version(name)
    if canary is not None and routing_percent(routing_key) < policy.canary_percent:
        return canary
    return ledger.active_version(name)


def _ref(record: AgentVersionRecord) -> str:
    return f"{record.name}@{record.version}"


def canary_scorecards(ledger: Ledger, agent_ref: str) -> list[Scorecard]:
    """Rebuild per-run scorecards for every completed run of a version."""
    cards: list[Scorecard] = []
    for run in ledger.runs_for_agent(agent_ref):
        if run.phase.value not in ("completed", "failed"):
            continue
        results = ledger.eval_results(run.id)
        if results:
            cards.append(Scorecard.from_results(results))
    return cards


def _aggregate(agent_ref: str, cards: list[Scorecard]) -> Scorecard:
    """One representative scorecard over the observed canary runs."""
    return Scorecard(
        subject_type="agent_spec_version",
        subject_id=agent_ref,
        overall_score=mean(c.overall_score for c in cards),
        passed_suites=sorted({s for c in cards for s in c.passed_suites}),
        failed_suites=sorted({s for c in cards for s in c.failed_suites}),
        safety_regressions=sum(c.safety_regressions for c in cards),
        critical_failures=sum(c.critical_failures for c in cards),
        cases_total=len(cards),
    )


def observe_canary(
    ledger: Ledger,
    agent_ref: str,
    *,
    policy: PromotionPolicy = DEFAULT_POLICY,
) -> PromotionDecision | None:
    """Advance or roll back a canary from its observed runs; None = keep going.

    Call after any run completes; a no-op unless ``agent_ref`` is the current
    canary version of its agent. Terminal decisions mutate the ledger:
    promote activates the canary and archives the previous active version;
    reject archives the canary. Both are recorded as promotion decisions.
    """
    name, _, _version = agent_ref.partition("@")
    canary = ledger.canary_version(name)
    if canary is None or _ref(canary) != agent_ref:
        return None

    cards = canary_scorecards(ledger, agent_ref)
    if not cards:
        return None

    decision = evaluate_canary(_aggregate(agent_ref, cards), cards, policy=policy)
    if decision.decision is Decision.canary:
        return None  # still observing; not worth a ledger row per run

    if decision.decision is Decision.promote:
        previous = ledger.active_version(name)
        ledger.upsert_agent_version(canary.model_copy(update={"status": "active"}))
        if previous is not None:
            ledger.upsert_agent_version(previous.model_copy(update={"status": "archived"}))
        log.info(
            "canary promoted",
            extra={"context": {"agent": agent_ref, "observed_runs": len(cards)}},
        )
    else:  # reject -> roll back
        ledger.upsert_agent_version(canary.model_copy(update={"status": "archived"}))
        log.warning(
            "canary rolled back",
            extra={"context": {"agent": agent_ref, "rationale": decision.rationale}},
        )

    ledger.record_promotion(decision)
    return decision
