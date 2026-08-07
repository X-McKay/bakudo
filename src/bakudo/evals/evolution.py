"""Eval-first agent evolution (spec section 15).

The meta-agent never overwrites an active agent. It derives a *candidate*
version (here, prompt mutation — the safest first mutation type per §10), scores
both baseline and candidate over an eval corpus, infers whether the change
touches human-gated surfaces, and returns a promotion decision. Pure and
unit-tested; the Temporal ``AgentEvolutionWorkflow`` orchestrates it.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..agent_spec import AgentSpec
from ..agent_spec.models import SpecStatus
from .corpus import EvalCase, run_corpus
from .promotion import HUMAN_GATED_MUTATIONS, PromotionDecision, PromotionPolicy, decide
from .scorecard import Scorecard


def propose_prompt_mutation(
    baseline: AgentSpec, *, system_prompt: str, created_by: str = "agent-evolution@1"
) -> AgentSpec:
    """Derive a candidate spec with a rewritten system prompt (§15.1)."""
    next_version = baseline.metadata.version + 1
    new_metadata = baseline.metadata.model_copy(
        update={
            "version": next_version,
            "status": SpecStatus.candidate,
            "parent_version": baseline.metadata.version,
            "owner": created_by,
        }
    )
    new_prompt = baseline.prompt.model_copy(update={"system": system_prompt})
    return baseline.model_copy(update={"metadata": new_metadata, "prompt": new_prompt})


# Production-write tools whose introduction requires human approval (§19.2).
_PRODUCTION_WRITE_TOOLS = frozenset({"deploy", "publish", "db-write", "production-write"})


def infer_mutation_kinds(baseline: AgentSpec, candidate: AgentSpec) -> list[str]:
    """Detect human-gated mutation surfaces introduced by a candidate (§15.3)."""
    kinds: list[str] = []

    new_bundles = set(candidate.sandbox.network_bundles) - set(baseline.sandbox.network_bundles)
    widened = (
        candidate.sandbox.network_mode.value == "open"
        and baseline.sandbox.network_mode.value != "open"
    )
    if new_bundles or widened:
        kinds.append("broader-network-access")

    new_tools = candidate.tool_names() - baseline.tool_names()
    if new_tools & _PRODUCTION_WRITE_TOOLS:
        kinds.append("production-write-tool")

    if candidate.role.type.value == "release-manager" and baseline.role.type != candidate.role.type:
        kinds.append("self-modifying-meta-agent")

    # Only return kinds that are actually gated.
    return [k for k in kinds if k in HUMAN_GATED_MUTATIONS]


@dataclass
class EvolutionResult:
    decision: PromotionDecision
    baseline: Scorecard
    candidate: Scorecard


def evolve_agent(
    baseline: AgentSpec,
    candidate: AgentSpec,
    cases: list[EvalCase],
    run_fn,
    *,
    policy: PromotionPolicy | None = None,
) -> EvolutionResult:
    """Score baseline vs candidate over the corpus and decide promotion.

    ``run_fn(spec, objective) -> CaseRun`` runs one case with a given spec.
    """
    baseline_results = run_corpus(
        f"{baseline.metadata.name}-baseline",
        cases,
        lambda obj: run_fn(baseline, obj),
        subject_id=f"{baseline.metadata.name}@{baseline.metadata.version}",
    )
    candidate_results = run_corpus(
        f"{candidate.metadata.name}-candidate",
        cases,
        lambda obj: run_fn(candidate, obj),
        subject_id=f"{candidate.metadata.name}@{candidate.metadata.version}",
    )
    baseline_card = Scorecard.from_results(baseline_results)
    candidate_card = Scorecard.from_results(candidate_results)

    decision = decide(
        candidate_card,
        baseline_card,
        policy=policy,
        mutation_kinds=infer_mutation_kinds(baseline, candidate),
    )
    return EvolutionResult(decision, baseline_card, candidate_card)
