"""Plain (SDK-free) implementations behind the Temporal activities.

Keeping the logic here means it is exercised by unit tests without a Temporal
worker. A process-global :class:`Deps` bundle lets the worker inject the real
ledger and sandbox driver; tests use the in-memory defaults.
"""

from __future__ import annotations

import os
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

from .. import ids
from ..abox.local import local_sandbox
from ..abox.runner import AboxOutcome, AboxRunner
from ..agent_spec import AgentSpec, parse_spec
from ..bundle import Budget, MemoryExcerpt, TaskBundle
from ..curriculum import build_default_collector, generate_objectives
from ..curriculum.collectors import SignalCollector
from ..curriculum.objective import Objective
from ..evals import EvalContext, Scorecard, decide, run_suite
from ..evals.corpus import CaseRun, load_corpus
from ..evals.evolution import evolve_agent
from ..evals.promotion import PromotionPolicy, apply_decision, routes_to_canary
from ..memory.compaction import compact
from ..memory.semantic import SemanticMemoryStore
from ..registry import InMemoryLedger, RunPhase, RunRecord
from ..registry.ledger import Ledger
from ..runner.result import RunResult, RunStatus
from .shared import (
    AgentRunInput,
    CompactionInput,
    EvalInput,
    EvolutionInput,
    ObserveInput,
    PromotionInput,
)

SandboxFn = Callable[[TaskBundle], AboxOutcome]


@dataclass
class Deps:
    """Injectable dependencies for the activity implementations."""

    ledger: Ledger = field(default_factory=InMemoryLedger)
    sandbox: SandboxFn | None = None
    memory: object = field(default_factory=SemanticMemoryStore)
    collector: SignalCollector | None = None

    def sandbox_fn(self) -> SandboxFn:
        """Resolve the sandbox driver, failing *closed*.

        The in-process ``local_sandbox`` is not an isolation boundary, so it is
        never selected implicitly: ``BAKUDO_SANDBOX`` must be ``abox`` or
        ``local``, and ``local`` is only permitted when ``BAKUDO_ENV=dev``.
        """
        if self.sandbox is not None:
            return self.sandbox

        mode = os.environ.get("BAKUDO_SANDBOX")
        if mode is None and os.environ.get("BAKUDO_USE_ABOX") == "1":
            mode = "abox"  # backwards-compatible alias

        if mode == "abox":
            return AboxRunner().run
        if mode == "local":
            if os.environ.get("BAKUDO_ENV") != "dev":
                raise RuntimeError(
                    "BAKUDO_SANDBOX=local requires BAKUDO_ENV=dev; the local "
                    "sandbox is not an isolation boundary."
                )
            return local_sandbox
        if mode is None:
            raise RuntimeError(
                "BAKUDO_SANDBOX must be set to 'abox' or 'local' "
                "(local is dev-only). Refusing to pick a sandbox implicitly."
            )
        raise RuntimeError(f"Unknown BAKUDO_SANDBOX value: {mode!r}")


DEPS = Deps()


def configure(
    *,
    ledger: Ledger | None = None,
    sandbox: SandboxFn | None = None,
    memory: object | None = None,
    collector: SignalCollector | None = None,
) -> None:
    """Inject real dependencies (called by the worker entrypoint)."""
    if ledger is not None:
        DEPS.ledger = ledger
    if sandbox is not None:
        DEPS.sandbox = sandbox
    if memory is not None:
        DEPS.memory = memory
    if collector is not None:
        DEPS.collector = collector


def _budget_for(spec: AgentSpec, timeout_seconds: int) -> Budget:
    """Budget for a bundle: ``bakudo.bundle.budget_from_spec`` when it exists
    (landing separately), else the current input-timeout behavior."""
    from .. import bundle as bundle_mod

    budget_from_spec = getattr(bundle_mod, "budget_from_spec", None)
    if callable(budget_from_spec):
        return budget_from_spec(spec)
    return Budget(timeoutSeconds=timeout_seconds)


def _bundle_from_input(inp: AgentRunInput) -> TaskBundle:
    spec = parse_spec(inp.agent_spec)
    return TaskBundle(
        run_id=inp.run_id,
        objective_id=inp.objective["id"],
        objective=Objective.model_validate(inp.objective),
        agent_spec=spec,
        memory_excerpts=[MemoryExcerpt.model_validate(m) for m in inp.memory_excerpts],
        eval_rubric=inp.eval_rubric,
        budget=_budget_for(spec, inp.timeout_seconds),
    )


def create_run(inp: AgentRunInput, workflow_id: str) -> dict:
    """Create the run ledger record (called once at workflow start)."""
    meta = inp.agent_spec["metadata"]
    record = RunRecord(
        id=inp.run_id,
        temporal_workflow_id=workflow_id,
        abox_task_id=inp.run_id,
        objective_id=inp.objective["id"],
        agent_ref=f"{meta['name']}@{meta['version']}",
        git_branch=ids.git_branch_for(inp.run_id),
    )
    ledger = DEPS.ledger
    if hasattr(ledger, "create_run"):
        # Pass the objective document so durable ledgers can upsert the
        # objectives row the runs FK points at (TMP-2).
        ledger.create_run(record, objective=inp.objective)
    return {"run_id": record.id, "git_branch": record.git_branch}


def load_agent_spec(name: str, run_id: str | None = None) -> dict | None:
    """Load an agent spec document by name for meta-agent dispatch (TMP-3).

    Prefers the ledger's ACTIVE version — never candidates, rejected, or
    archived versions (design §2, fixes OPT-5). When a canary version exists
    and ``run_id`` is given, ``hash(run_id) % 100 < canary_percent``
    deterministically routes that run to the canary. Falls back to the repo's
    seed ``agents/<name>.yaml``. Returns ``None`` when nothing resolves — the
    workflow dead-letters the objective rather than crashing.
    """
    import yaml

    def _doc(record) -> dict | None:
        try:
            doc = yaml.safe_load(record.spec_yaml)
        except yaml.YAMLError:
            return None
        return doc if isinstance(doc, dict) else None

    ledger = DEPS.ledger
    canary_version = getattr(ledger, "canary_version", None)
    if run_id is not None and callable(canary_version):
        canary = canary_version(name)
        if canary is not None and routes_to_canary(
            run_id, PromotionPolicy().canary_percent
        ):
            doc = _doc(canary)
            if doc is not None:
                return doc

    active = getattr(ledger, "active_version", None)
    if callable(active):
        record = active(name)
        if record is not None:
            doc = _doc(record)
            if doc is not None:
                return doc

    # Repo seed specs; reject anything that is not a bare agent name.
    if not name or "/" in name or "\\" in name or ".." in name:
        return None
    path = Path(__file__).resolve().parents[3] / "agents" / f"{name}.yaml"
    if not path.is_file():
        return None
    doc = yaml.safe_load(path.read_text())
    return doc if isinstance(doc, dict) else None


def render_bundle(inp: AgentRunInput) -> dict:
    bundle = _bundle_from_input(inp)
    return bundle.model_dump(by_alias=True, mode="json")


def run_sandbox(bundle_dict: dict) -> dict:
    bundle = TaskBundle.model_validate(bundle_dict)
    outcome = DEPS.sandbox_fn()(bundle)
    return {
        "run_id": outcome.run_id,
        "abox_task_id": outcome.abox_task_id,
        "exit_code": outcome.exit_code,
        "git_branch": outcome.git_branch,
        "result": outcome.result,
        "diff": outcome.diff,
        "changed_files": outcome.changed_files,
        "denied_commands": outcome.denied_commands,
        "runtime_seconds": outcome.runtime_seconds,
        "tokens_used": outcome.tokens_used,
        "observability": outcome.observability,
        "succeeded": outcome.succeeded,
    }


def persist_run(run_id: str, phase: str, payload: dict) -> None:
    """Advance a run's phase in whichever ledger is configured.

    Backend-agnostic: both the in-memory and Postgres ledgers implement the
    same sync :class:`~bakudo.registry.ledger.Ledger` Protocol.
    """
    ledger = DEPS.ledger
    ph = RunPhase(phase)
    try:
        if ph.is_terminal:
            ledger.finish_run(run_id, ph, payload.get("result"))
        else:
            ledger.set_phase(run_id, ph)
    except KeyError:
        # Run record not present yet (e.g. created event raced); safe to skip.
        pass


def run_eval_suite(inp: EvalInput) -> dict:
    ctx = EvalContext(
        result=RunResult.model_validate(inp.result),
        objective=Objective.model_validate(inp.objective),
        diff=inp.diff,
        denied_commands=inp.denied_commands,
        runtime_seconds=inp.runtime_seconds,
        tokens_used=inp.tokens_used,
        schema_valid=inp.schema_valid,
    )
    # Suite selection keys off the objective: optimize runs add perf/simplicity.
    results = run_suite(ctx)
    scorecard = Scorecard.from_results(results)
    record_eval = getattr(DEPS.ledger, "record_eval", None)
    if callable(record_eval):
        for r in results:
            record_eval(r)
    return {
        "eval_results": [r.to_dict() for r in results],
        "scorecard": scorecard.model_dump(mode="json"),
    }


def decide_promotion(inp: PromotionInput) -> dict:
    candidate = Scorecard.model_validate(inp.candidate)
    baseline = Scorecard.model_validate(inp.baseline) if inp.baseline else None
    decision = decide(
        candidate, baseline,
        policy=PromotionPolicy(), mutation_kinds=inp.mutation_kinds,
    )
    # Record + transition the candidate version through the §1 state machine.
    apply_decision(DEPS.ledger, decision)
    return decision.to_dict()


def _run_case(spec: AgentSpec, objective: Objective) -> CaseRun:
    """Run one eval case in the configured sandbox and shape it for grading."""
    bundle = TaskBundle(
        run_id=ids.run_id(),
        objective_id=objective.id,
        objective=objective,
        agent_spec=spec,
        budget=Budget(timeoutSeconds=spec.sandbox.timeout_seconds),
    )
    outcome = DEPS.sandbox_fn()(bundle)
    if outcome.result:
        result = RunResult.model_validate(outcome.result)
    else:
        result = RunResult(
            run_id=bundle.run_id, agent=spec.ref, objective_id=objective.id,
            status=RunStatus.failed, summary="no result produced",
        )
    return CaseRun(
        result=result, diff=outcome.diff, denied_commands=outcome.denied_commands
    )


def run_agent_evolution(inp: EvolutionInput) -> dict:
    """Score a candidate spec against a baseline over an eval corpus (§15)."""
    baseline = parse_spec(inp.baseline_spec)
    candidate = parse_spec(inp.candidate_spec)
    _, cases = load_corpus(inp.corpus_path)
    outcome = evolve_agent(baseline, candidate, cases, _run_case)

    if callable(getattr(DEPS.ledger, "record_promotion", None)):
        # Record + transition the candidate version (design §1/§4).
        apply_decision(DEPS.ledger, outcome.decision)
    return {
        "decision": outcome.decision.to_dict(),
        "baseline_scorecard": outcome.baseline.model_dump(mode="json"),
        "candidate_scorecard": outcome.candidate.model_dump(mode="json"),
    }


def compact_memories(inp: CompactionInput) -> dict:
    """Compact a run's emitted memories into the durable store (§14, §10.1)."""
    result = RunResult.model_validate(inp.result)
    report = compact(result, DEPS.memory, repo=inp.repo)
    return {"written": report.written, "rejected": report.rejected}


def collect_signals(inp: ObserveInput) -> list[dict]:
    """Collect repo signals and emit candidate objectives (§16.1).

    Uses the injected collector, or one assembled from environment config
    (``BAKUDO_REPO_PATH``, ``BAKUDO_COVERAGE_XML``, ``BAKUDO_JUNIT_XML``,
    ``GITHUB_TOKEN``). Returns an empty backlog when nothing is configured,
    rather than guessing.
    """
    collector = DEPS.collector or build_default_collector(inp.repo)
    if collector is None:
        return []
    signals = collector.collect(inp.repo)
    return [obj.to_dict() for obj in generate_objectives(signals)]
