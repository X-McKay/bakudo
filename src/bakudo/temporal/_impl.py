"""Plain (SDK-free) implementations behind the Temporal activities.

Keeping the logic here means it is exercised by unit tests without a Temporal
worker. A process-global :class:`Deps` bundle lets the worker inject the real
ledger and sandbox driver; tests use the in-memory defaults.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import yaml

from .. import ids
from ..abox.select import SandboxFn, resolve_sandbox
from ..agent_spec import AgentSpec, parse_spec
from ..bundle import Budget, MemoryExcerpt, TaskBundle
from ..control.pipeline import build_bundle, enforce_sandbox_budgets, grade_run
from ..curriculum import build_default_collector, generate_objectives
from ..curriculum.collectors import SignalCollector
from ..curriculum.objective import Objective
from ..evals import Scorecard, decide
from ..evals.corpus import CaseRun, load_corpus
from ..evals.evolution import evolve_agent
from ..evals.promotion import PromotionPolicy
from ..memory.compaction import compact
from ..memory.semantic import SemanticMemoryStore
from ..memory.store import MemoryStore
from ..paths import agents_dir
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


@dataclass
class Deps:
    """Injectable dependencies for the activity implementations.

    This is the worker-level injection seam: :func:`configure` wires the real
    ledger/memory/sandbox at process start, tests swap fields directly. All
    fields are typed against their Protocols — no duck-typing downstream.
    """

    ledger: Ledger = field(default_factory=InMemoryLedger)
    sandbox: SandboxFn | None = None
    memory: MemoryStore = field(default_factory=SemanticMemoryStore)
    collector: SignalCollector | None = None

    def sandbox_fn(self) -> SandboxFn:
        """Resolve the sandbox driver, failing *closed*.

        Delegates to :func:`bakudo.abox.select.resolve_sandbox`, the single
        selection policy shared with the synchronous pipeline.
        """
        return resolve_sandbox(self.sandbox)


DEPS = Deps()


def configure(
    *,
    ledger: Ledger | None = None,
    sandbox: SandboxFn | None = None,
    memory: MemoryStore | None = None,
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
    DEPS.ledger.create_run(record)
    return {"run_id": record.id, "git_branch": record.git_branch}


def render_bundle(inp: AgentRunInput) -> dict:
    """Render the task bundle via the shared pipeline core (memory included)."""
    bundle = build_bundle(
        Objective.model_validate(inp.objective),
        parse_spec(inp.agent_spec),
        run_id=inp.run_id,
        memory=DEPS.memory,
        memory_excerpts=[MemoryExcerpt.model_validate(m) for m in inp.memory_excerpts],
        timeout_seconds=inp.timeout_seconds,
    )
    return bundle.model_dump(by_alias=True, mode="json")


# Default seed agent for each objective type when neither the objective nor
# the curriculum names one (§9). Dispatching an optimize objective as a plain
# run gets the read-only scout; the full loop is OptimizationWorkflow's job.
DEFAULT_AGENT_FOR_TYPE = {
    "explore": "explore",
    "add-feature": "add-feature",
    "qa": "qa",
    "critic": "critic",
    "maintenance": "add-feature",
    "optimize": "optimize-scout",
}


def resolve_agent_spec(agent: str | None, objective_type: str) -> dict | None:
    """Resolve the AgentSpec document to run for an objective.

    Prefers the ledger's active version of the named (or type-default) agent,
    falling back to the bundled seed specs. Returns ``None`` when no agent can
    be resolved, so the caller can dead-letter the objective instead of
    crashing the dispatch loop.
    """
    name = agent or DEFAULT_AGENT_FOR_TYPE.get(objective_type)
    if name is None:
        return None

    record = DEPS.ledger.active_version(name)
    if record is not None:
        document = yaml.safe_load(record.spec_yaml)
        if isinstance(document, dict):
            return document

    seed = agents_dir() / f"{name}.yaml"
    if seed.is_file():
        document = yaml.safe_load(seed.read_text())
        if isinstance(document, dict):
            return document
    return None


def run_sandbox(bundle_dict: dict) -> dict:
    bundle = TaskBundle.model_validate(bundle_dict)
    outcome = enforce_sandbox_budgets(bundle.agent_spec, DEPS.sandbox_fn()(bundle))
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
    """Grade one run via the shared pipeline core (single EvalContext site)."""
    graded = grade_run(
        Objective.model_validate(inp.objective),
        inp.result,
        ledger=DEPS.ledger,
        run_id=inp.run_id,
        diff=inp.diff,
        denied_commands=inp.denied_commands,
        runtime_seconds=inp.runtime_seconds,
        tokens_used=inp.tokens_used,
        schema_valid_hint=inp.schema_valid,
    )
    return {
        "eval_results": [r.to_dict() for r in graded.eval_results],
        "scorecard": graded.scorecard.model_dump(mode="json"),
    }


def decide_promotion(inp: PromotionInput) -> dict:
    candidate = Scorecard.model_validate(inp.candidate)
    baseline = Scorecard.model_validate(inp.baseline) if inp.baseline else None
    decision = decide(
        candidate, baseline,
        policy=PromotionPolicy(), mutation_kinds=inp.mutation_kinds,
    )
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

    DEPS.ledger.record_promotion(outcome.decision)
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
