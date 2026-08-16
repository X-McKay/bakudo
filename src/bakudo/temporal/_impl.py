"""Plain (SDK-free) implementations behind the Temporal activities.

Keeping the logic here means it is exercised by unit tests without a Temporal
worker. A process-global :class:`Deps` bundle lets the worker inject the real
ledger and sandbox driver; tests use the in-memory defaults.
"""

from __future__ import annotations

import os
import tempfile
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any

from .. import __version__ as bakudo_version
from .. import ids, paths
from ..abox.local import local_sandbox
from ..abox.runner import AboxOutcome, AboxRunner
from ..agent_spec import AgentSpec, parse_spec
from ..bundle import Budget, MemoryExcerpt, TaskBundle
from ..curriculum import build_default_collector, generate_objectives
from ..curriculum.collectors import SignalCollector
from ..curriculum.objective import Objective
from ..evals import EvalContext, Scorecard, assemble_suite, decide
from ..evals.corpus import CaseRun, load_corpus
from ..evals.evolution import evolve_agent
from ..evals.promotion import PromotionPolicy, apply_decision, routes_to_canary
from ..memory.compaction import compact
from ..memory.semantic import SemanticMemoryStore
from ..registry import InMemoryLedger, RunPhase, RunRecord
from ..registry.ledger import Ledger
from ..runner.result import RunResult, RunStatus
from ..scenarios.provision import provision
from ..scenarios.testrun import TestRunner, TestRunResult
from ..trials.models import TrialRecord
from .shared import (
    AgentRunInput,
    CompactionInput,
    EvalInput,
    EvolutionInput,
    ObserveInput,
    PromotionInput,
)

if TYPE_CHECKING:
    from ..scenarios.registry import ScenarioRegistry

SandboxFn = Callable[[TaskBundle], AboxOutcome]
ScenarioRegistryFn = Callable[[], "ScenarioRegistry"]

# How to turn a sandbox-less deployment into a sandboxed one (TMP-13). Shared
# by the fail-fast RuntimeError below and the worker's startup posture log
# (bakudo.temporal.worker.log_sandbox_posture) so the two can never drift.
SANDBOX_REMEDIATION = (
    "To enable real sandboxing, mount the host abox binary and /dev/kvm into "
    "the worker and set BAKUDO_SANDBOX=abox (see infra/docker-compose.yml)."
)

# Mirrors SANDBOX_REMEDIATION: single source of truth for the hidden-eval
# fail-closed message, shared by Deps.resolve_hidden_eval_fn (runtime) and
# any future worker startup posture log, so the two can never drift.
HIDDEN_EVAL_REMEDIATION = (
    "TODO(follow-up plan: corpus & integration): grading hidden tests "
    "outside BAKUDO_ENV=dev requires a first-class abox-backed hidden-test "
    "runner (bench-style sandbox exec), which does not exist yet. Set "
    "BAKUDO_ENV=dev to use the local (host-executing, dev-only) test runner, "
    "or inject Deps.hidden_eval_fn with a trusted runner."
)


def resolve_sandbox_mode() -> str | None:
    """The configured sandbox mode: ``BAKUDO_SANDBOX``, honouring the
    backwards-compatible ``BAKUDO_USE_ABOX=1`` alias; ``None`` when unset.

    The single source of truth for mode resolution — :meth:`Deps.sandbox_fn`
    (runtime behavior) and the worker's startup posture log both use it.
    """
    mode = os.environ.get("BAKUDO_SANDBOX")
    if mode is None and os.environ.get("BAKUDO_USE_ABOX") == "1":
        return "abox"
    return mode


def _default_scenario_registry() -> ScenarioRegistry:
    """The real, on-disk scenario registry (``paths.scenarios_dir()``).

    Assigned as ``Deps.scenario_registry_fn``'s default *value* (a function
    reference, not a call) so no directory I/O happens at ``Deps()``
    construction/import time -- only when an activity actually resolves the
    registry.
    """
    from .. import paths
    from ..scenarios.registry import ScenarioRegistry

    return ScenarioRegistry(paths.scenarios_dir())


def _default_hidden_eval_fn(workspace: Any, command: str) -> TestRunResult:
    """Fail-closed default hidden-test runner (mirrors ``Deps.sandbox_fn``'s
    resolution pattern, :func:`resolve_sandbox_mode`).

    ``BAKUDO_ENV=dev`` opts into the local, host-executing runner (the same
    one ``bakudo trial run``/``bakudo experiment run`` use, and the only one
    safe for scenario fixture/agent code today). Any other posture refuses
    rather than silently executing untrusted diff-adjacent code on the host.
    """
    if os.environ.get("BAKUDO_ENV") == "dev":
        from ..scenarios.testrun import local_test_runner

        return local_test_runner(workspace, command)
    raise RuntimeError(HIDDEN_EVAL_REMEDIATION)


@dataclass
class Deps:
    """Injectable dependencies for the activity implementations."""

    ledger: Ledger = field(default_factory=InMemoryLedger)
    sandbox: SandboxFn | None = None
    memory: object = field(default_factory=SemanticMemoryStore)
    collector: SignalCollector | None = None
    # Issue #28: injectable independent bench measurer
    # ((diff, bench_command) -> (before_s, after_s)); None resolves the
    # fresh-sandbox abox measurer when the abox sandbox is active.
    bench_measure: Callable[[str, str], tuple[float, float]] | None = None
    # Experiment substrate (Task 11): a factory returning a ScenarioRegistry
    # (never the registry itself -- constructing one does directory I/O, so
    # activities call this fresh rather than sharing a stale instance across
    # a long-lived worker process) and the hidden-test TestRunner. Both
    # default to real, env/paths-driven behavior (see the module-level
    # functions above) so tests are the only callers that need to override
    # them.
    scenario_registry_fn: ScenarioRegistryFn = _default_scenario_registry
    hidden_eval_fn: TestRunner = _default_hidden_eval_fn

    def sandbox_fn(self) -> SandboxFn:
        """Resolve the sandbox driver, failing *closed*.

        The in-process ``local_sandbox`` is not an isolation boundary, so it is
        never selected implicitly: ``BAKUDO_SANDBOX`` must be ``abox`` or
        ``local``, and ``local`` is only permitted when ``BAKUDO_ENV=dev``.
        """
        if self.sandbox is not None:
            return self.sandbox

        mode = resolve_sandbox_mode()

        if mode == "abox":
            return AboxRunner().run
        if mode == "local":
            if os.environ.get("BAKUDO_ENV") != "dev":
                raise RuntimeError(
                    "BAKUDO_SANDBOX=local requires BAKUDO_ENV=dev; the local "
                    "sandbox is not an isolation boundary."
                )
            return local_sandbox
        if mode == "unavailable":
            # TMP-13: the declared posture of deployments that cannot sandbox
            # (e.g. the default docker-compose worker image, which ships no
            # abox binary or KVM). Fail loud and actionable, never hang or
            # silently no-op.
            raise RuntimeError(
                "sandbox runs are unavailable in this deployment "
                "(BAKUDO_SANDBOX=unavailable): the worker image has no abox "
                f"binary and no /dev/kvm. {SANDBOX_REMEDIATION}"
            )
        if mode is None:
            raise RuntimeError(
                "BAKUDO_SANDBOX must be set to 'abox' or 'local' "
                "(local is dev-only). Refusing to pick a sandbox implicitly."
            )
        raise RuntimeError(f"Unknown BAKUDO_SANDBOX value: {mode!r}")


DEPS = Deps()

# The promotion policy consulted by the graduation/decision activities.
# Module-level so operators/tests can swap it without patching call sites.
PROMOTION_POLICY = PromotionPolicy()


def configure(
    *,
    ledger: Ledger | None = None,
    sandbox: SandboxFn | None = None,
    memory: object | None = None,
    collector: SignalCollector | None = None,
    scenario_registry_fn: ScenarioRegistryFn | None = None,
    hidden_eval_fn: TestRunner | None = None,
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
    if scenario_registry_fn is not None:
        DEPS.scenario_registry_fn = scenario_registry_fn
    if hidden_eval_fn is not None:
        DEPS.hidden_eval_fn = hidden_eval_fn


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
    try:
        path = paths.agents_dir() / f"{name}.yaml"
    except FileNotFoundError:
        # No bundled agents data on this install: same contract as an unknown
        # name — None dead-letters the objective instead of crashing.
        return None
    if not path.is_file():
        return None
    doc = yaml.safe_load(path.read_text())
    return doc if isinstance(doc, dict) else None


def render_bundle(inp: AgentRunInput) -> dict:
    bundle = _bundle_from_input(inp)
    return bundle.model_dump(by_alias=True, mode="json")


def _sandbox_accepts_cancel_event(fn: object) -> bool:
    """Whether a sandbox callable takes a ``cancel_event`` (SEC-5).

    The abox runner and local sandbox do; injected test stubs (``fn(bundle)``)
    do not, so cancellation plumbing is passed only when supported rather than
    breaking a stub with an unexpected kwarg.
    """
    import inspect

    try:
        params = inspect.signature(fn).parameters  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return False
    return "cancel_event" in params or any(
        p.kind == inspect.Parameter.VAR_KEYWORD for p in params.values()
    )


def run_sandbox(bundle_dict: dict, cancel_event: object | None = None) -> dict:
    bundle = TaskBundle.model_validate(bundle_dict)
    fn: Any = DEPS.sandbox_fn()
    if cancel_event is not None and _sandbox_accepts_cancel_event(fn):
        outcome = fn(bundle, cancel_event=cancel_event)
    else:
        outcome = fn(bundle)
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
        # Failure breadcrumbs: live cycles were undiagnosable without them.
        "error": outcome.error,
        "stderr": outcome.stderr[-2000:],
    }


def measure_winner_bench(diff: str, bench_command: str, repo: str) -> dict:
    """Independently re-measure a winner's bench claim (issue #28).

    Returns ``{"before": s, "after": s}`` from a fresh-sandbox measurement,
    or ``{"skipped": reason}`` when no measurer is available (non-abox
    sandboxes) — the workflow then accepts the winner unverified, matching
    the in-process loop's ``bench_measure=None`` behaviour.
    """
    measure = DEPS.bench_measure
    if measure is None:
        if os.environ.get("BAKUDO_SANDBOX") != "abox":
            return {"skipped": "bench verification requires the abox sandbox"}
        from ..abox.bench import abox_bench_measure, resolve_repo_path

        measure = abox_bench_measure(resolve_repo_path(repo))
    before, after = measure(diff, bench_command)
    return {"before": before, "after": after}


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
    # Unified assembly (TMP-22): the objective-type-aware base suite plus the
    # sandboxed critic (design §5, OPT-8) — reviewed by a real read-only agent
    # through the same sandbox driver as the run. With no sandbox available
    # (offline/dev) the critic is omitted and a policy requiring `critic` fails
    # loudly at decision time. The Temporal path is the only one that runs with
    # a live sandbox, hence the only one that assembles the critic.
    try:
        critic_sandbox: SandboxFn | None = DEPS.sandbox_fn()
    except RuntimeError:
        critic_sandbox = None
    results = assemble_suite(ctx, sandbox=critic_sandbox, with_critic=True)

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


def _window_stats(ledger: Ledger, runs: list) -> dict | None:
    """Aggregate scorecard stats over a window of completed runs.

    Runs whose eval results were never recorded are skipped; returns ``None``
    when nothing is measurable.
    """
    scores: list[float] = []
    safety_regressions = 0
    critical_failures = 0
    for run in runs:
        results = ledger.eval_results(run.id)
        if not results:
            continue
        card = Scorecard.from_results(results)
        scores.append(card.overall_score)
        safety_regressions += card.safety_regressions
        critical_failures += card.critical_failures
    if not scores:
        return None
    return {
        "mean_score": sum(scores) / len(scores),
        "runs": len(scores),
        "safety_regressions": safety_regressions,
        "critical_failures": critical_failures,
    }


def check_canary_graduation(name: str) -> dict:
    """Graduate or roll back a canary version after a finished run (design §3).

    Invoked from AgentRunWorkflow's completion path; the workflow stays
    deterministic because every read/compare/transition happens here, ledger-
    side. Once the canary has ``policy.canary.minRuns`` completed runs, its
    mean ``overall_score`` and hard counters (safety_regressions == 0,
    critical_failures == 0) are compared against the active version's trailing
    runs over the same window: better-or-equal graduates (canary -> active,
    old active -> archived), worse rolls back (canary -> rejected). Every
    transition is a ledger write with an event, plus a recorded decision.
    """
    from datetime import UTC, datetime

    from ..evals.promotion import Decision, PromotionDecision

    ledger = DEPS.ledger
    policy = PROMOTION_POLICY

    canary_version = getattr(ledger, "canary_version", None)
    if not callable(canary_version):
        return {"status": "no-canary", "agent": name}
    canary = canary_version(name)
    if canary is None:
        return {"status": "no-canary", "agent": name}

    canary_ref = f"{name}@{canary.version}"
    window = policy.canary_min_runs
    canary_runs = ledger.completed_runs(canary_ref, limit=window)
    if len(canary_runs) < window:
        return {
            "status": "insufficient-runs", "agent": canary_ref,
            "runs": len(canary_runs), "required": window,
        }
    canary_stats = _window_stats(ledger, canary_runs)
    if canary_stats is None or canary_stats["runs"] < window:
        return {
            "status": "insufficient-runs", "agent": canary_ref,
            "runs": 0 if canary_stats is None else canary_stats["runs"],
            "required": window,
        }

    active = ledger.active_version(name)
    active_stats = None
    if active is not None:
        active_stats = _window_stats(
            ledger, ledger.completed_runs(f"{name}@{active.version}", limit=window)
        )
    baseline_mean = active_stats["mean_score"] if active_stats else None

    card = Scorecard(
        subject_type="agent_spec_version",
        subject_id=canary_ref,
        overall_score=max(0.0, min(1.0, canary_stats["mean_score"])),
        safety_regressions=canary_stats["safety_regressions"],
        critical_failures=canary_stats["critical_failures"],
        cases_total=canary_stats["runs"],
    )

    hard_failure = (
        canary_stats["safety_regressions"] > 0
        or canary_stats["critical_failures"] > 0
    )
    worse = baseline_mean is not None and canary_stats["mean_score"] < baseline_mean

    if hard_failure or worse:
        reason = (
            f"canary rollback: safety_regressions="
            f"{canary_stats['safety_regressions']}, critical_failures="
            f"{canary_stats['critical_failures']}"
            if hard_failure
            else (
                f"canary rollback: mean score {canary_stats['mean_score']:.3f} "
                f"below active baseline {baseline_mean:.3f}"
            )
        )
        # Same compare-and-set guard as graduation (TMP-23): only the first
        # finisher rolls the canary back; a concurrent second is a no-op.
        rolled = ledger.set_version_status(
            name, canary.version, "rejected", reason=reason, expected_status="canary"
        )
        if rolled is None:
            return {"status": "already-resolved", "agent": canary_ref}
        ledger.record_promotion(
            PromotionDecision(
                Decision.reject, reason, card,
                status="rejected", approved_by="canary-graduation",
                resolved_at=datetime.now(UTC),
            )
        )
        return {"status": "rolled-back", "agent": canary_ref, "reason": reason}

    reason = (
        f"canary graduated: mean score {canary_stats['mean_score']:.3f} over "
        f"{canary_stats['runs']} runs"
        + (f" >= active baseline {baseline_mean:.3f}" if baseline_mean is not None
           else " with no active baseline runs")
    )
    # Compare-and-set on the canary status (TMP-23): two runs finishing near-
    # simultaneously both reach here, but only the first flips canary->active;
    # the second's guarded transition is a no-op (returns None) and it bails
    # without double-archiving the old active or recording a duplicate promotion.
    graduated = ledger.set_version_status(
        name, canary.version, "active", reason=reason, expected_status="canary"
    )
    if graduated is None:
        return {"status": "already-resolved", "agent": canary_ref}
    if active is not None:
        ledger.set_version_status(
            name, active.version, "archived",
            reason=f"superseded by {canary_ref}",
        )
    ledger.record_promotion(
        PromotionDecision(
            Decision.promote, reason, card,
            status="approved", approved_by="canary-graduation",
            resolved_at=datetime.now(UTC),
        )
    )
    return {"status": "graduated", "agent": canary_ref, "reason": reason}


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


_TERMINAL_RUN_PHASES = {"completed", "failed", "cancelled", "archived"}


def reconcile_runs(run_ids: list[str]) -> list[str]:
    """Return the run ids whose ledger record is already terminal (TMP-18).

    The meta-agent uses this to free concurrency slots held by runs that
    finished but whose ``run_completed`` signal was lost — reconciling against
    the authoritative terminal *status*, so a genuinely still-running child
    (its ledger phase is non-terminal) is never dropped. A run with no ledger
    record yet is left alone here (it may be mid-dispatch); the meta-agent's
    coarse time-TTL is the backstop for a record that never appears.
    """
    ledger = DEPS.ledger
    done: list[str] = []
    for run_id in run_ids:
        run = ledger.get_run(run_id)
        if run is not None and run.phase.value in _TERMINAL_RUN_PHASES:
            done.append(run_id)
    return done


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


# --- Experiment substrate (Task 11): trial/experiment activities ---
#
# select_scenarios/the scenario registry read the filesystem, so per
# controller ruling R1 they may never run in workflow code -- every scenario/
# agent-spec file I/O below is an activity. ExperimentWorkflow/TrialWorkflow
# build the deterministic trial matrix themselves from the plain descriptor
# dicts these activities return, using only the pure
# bakudo.experiments.design.trial_seed helper.


def resolve_experiment_scenarios(input: dict) -> dict:
    """Resolve an ExperimentSpec's scenario selection AND its arm refs.

    Runs :func:`bakudo.experiments.design.select_scenarios` (registry file
    I/O) so ``ExperimentWorkflow`` never has to (R1), and resolves every arm
    ref (``spec.baseline`` + ``spec.candidates``) the same on-disk,
    pinned-version-checked way :func:`provision_trial`
    (``_resolve_trial_agent_spec``) does. Returns
    ``{"scenarios": [descriptor, ...], "resolvedArms": {raw_ref: resolved_ref}}``.

    The arm resolution matters beyond labelling: every ``TrialRecord`` a
    ``TrialWorkflow`` child records carries the RESOLVED ref (whatever
    ``provision_trial``/``_resolve_trial_agent_spec`` actually loaded off
    disk), so if ``ExperimentWorkflow`` built its trial matrix and handed
    ``analyze_experiment`` the RAW (possibly unpinned) ``spec.baseline``/
    ``candidates`` instead, every ``TrialRecord.agent_ref == spec.baseline``
    comparison inside :func:`bakudo.experiments.runner.assemble_result`
    would silently fail to match and zero every statistic. Resolving once,
    here, keeps the trial matrix's arms and the spec ``analyze_experiment``/
    the persisted experiment row carry in lockstep with what actually ran.
    """
    from ..experiments.design import select_scenarios
    from ..experiments.models import ExperimentSpec

    spec = ExperimentSpec.model_validate(input["spec"])
    registry = DEPS.scenario_registry_fn()
    scenarios = select_scenarios(registry, spec)
    descriptors = [
        {
            "name": s.spec.metadata.name,
            "version": s.spec.metadata.version,
            "digest": s.digest,
            "family": s.spec.metadata.family.value,
            "twin_of": s.spec.metadata.twin_of,
        }
        for s in scenarios
    ]

    resolved_arms: dict[str, str] = {}
    for raw_ref in (spec.baseline, *spec.candidates):
        if raw_ref in resolved_arms:
            continue
        resolved_arms[raw_ref] = _resolve_trial_agent_spec(raw_ref).ref

    return {"scenarios": descriptors, "resolvedArms": resolved_arms}


def _resolve_trial_agent_spec(agent_ref: str) -> AgentSpec:
    """Load an arm's AgentSpec straight off disk, pinned-version-checked.

    Same contract as ``bakudo trial run``/``resolve_arm_pipeline_fn``
    (:mod:`bakudo.experiments.runner`): every arm resolves from
    ``agents_dir()/<name>.yaml``, and an ``@version`` pin that doesn't match
    what's on disk is a hard error -- a trial must never silently claim a
    version it didn't actually run.
    """
    from ..agent_spec import load_spec_file

    name, sep, version_s = agent_ref.partition("@")
    agent_spec = load_spec_file(paths.agents_dir() / f"{name}.yaml")
    if sep:
        try:
            requested_version = int(version_s)
        except ValueError as exc:
            raise ValueError(
                f"invalid agent version in {agent_ref!r}: {version_s!r} is not an integer"
            ) from exc
        if agent_spec.metadata.version != requested_version:
            raise ValueError(
                f"agent spec file for {name!r} is at version "
                f"{agent_spec.metadata.version}, but arm {agent_ref!r} requested "
                f"version {requested_version}"
            )
    return agent_spec


def provision_trial(input: dict) -> dict:
    """Provision a scenario's fixture workspace and derive its Objective.

    Mirrors ``run_trial``'s setup half (:mod:`bakudo.trials.runner`) plus
    ``resolve_arm_pipeline_fn``'s spec loading, folded into one activity
    since both are filesystem-bound: resolves the scenario (by ref/bare
    name) and the agent spec (pinned, off-disk) via the registry/agents_dir,
    provisions the scenario into a fresh scratch workspace, derives the
    Objective, and intersects the scenario's budget/network ceiling against
    the agent spec's own (tighten-only, same as ``build_pipeline_fn``) into
    an adjusted agent-spec document ready for ``AgentRunWorkflow``.

    NOTE: the scratch workspace is intentionally NOT cleaned up here (unlike
    ``run_trial``'s ``TemporaryDirectory`` context manager) -- it must
    outlive this activity call across the sandbox run and hidden-eval
    activities that follow in the same TrialWorkflow, which may execute on a
    different worker thread. Left for the OS temp reaper, matching how
    sandbox-side worktrees are not explicitly swept either.
    """
    from ..agent_spec.models import NetworkMode, SpecBudget
    from ..trials.runner import intersect_budgets, intersect_network, objective_from_scenario

    registry = DEPS.scenario_registry_fn()
    scenario = registry.get(input["scenario"])
    agent_spec = _resolve_trial_agent_spec(input["agent"])

    tmp_root = Path(tempfile.mkdtemp(prefix="bakudo-trial-"))
    ws = provision(scenario, tmp_root, seed=input["seed"])
    objective = objective_from_scenario(scenario, ws.repo_path)

    merged_budget = intersect_budgets(agent_spec.budget, scenario.spec.budgets)
    merged_network = intersect_network(
        agent_spec.sandbox.network_mode.value, scenario.spec.environment.network
    )

    budget_updates: dict[str, Any] = (
        dict(agent_spec.budget.model_dump()) if agent_spec.budget else {}
    )
    if "tokens" in merged_budget:
        budget_updates["max_tokens"] = merged_budget["tokens"]
    if "tool_calls" in merged_budget:
        budget_updates["max_tool_calls"] = merged_budget["tool_calls"]
    timeout_seconds = agent_spec.sandbox.timeout_seconds
    if "wall_seconds" in merged_budget:
        timeout_seconds = min(timeout_seconds, merged_budget["wall_seconds"])

    adjusted_spec = agent_spec.model_copy(
        update={
            "sandbox": agent_spec.sandbox.model_copy(
                update={
                    "network_mode": NetworkMode(merged_network),
                    "timeout_seconds": timeout_seconds,
                }
            ),
            "budget": SpecBudget(**budget_updates) if budget_updates else agent_spec.budget,
        }
    )

    return {
        "repo_path": str(ws.repo_path),
        "objective": objective.to_dict(),
        # AgentSpec.to_dict() (exclude_none=True) -- a bare model_dump would
        # serialize every unset-optional field as JSON null, which the
        # schema rejects for typed fields like budget/maxUsd or
        # tools[].policy (bakudo.schema.validate_agent_spec, invoked by
        # parse_spec inside render_bundle).
        "agent_spec": adjusted_spec.to_dict(),
        "agent_ref": agent_spec.ref,
        "scenario_name": scenario.spec.metadata.name,
        "scenario_version": scenario.spec.metadata.version,
        "scenario_digest": scenario.digest,
        "budgets": scenario.spec.budgets.model_dump(mode="json"),
        "network": scenario.spec.environment.network,
        # Same pins the sync run_trial records (bakudo/trials/runner.py):
        # {"bakudo": __version__, "scenario_digest_algo": "sha256"} merged
        # with build_pipeline_fn's PipelineResultLike.pins
        # ({"model_id": ..., "sandbox_profile": ...}). Built here (not in
        # workflow code) since it needs the resolved AgentSpec object.
        "pins": {
            "bakudo": bakudo_version,
            "scenario_digest_algo": "sha256",
            "model_id": adjusted_spec.model.model_id,
            "sandbox_profile": adjusted_spec.sandbox.profile,
        },
        "timeout_seconds": timeout_seconds,
    }


def evaluate_trial_hidden(input: dict) -> dict:
    """Grade a trial's collected diff against its scenario's hidden tests.

    Mirrors ``run_trial``'s grading tail (:mod:`bakudo.trials.runner`):
    :func:`bakudo.trials.hidden.evaluate` plus :func:`compute_hack_flags` and
    the expected/actual status comparison, all folded in here since they
    require the scenario (registry file I/O) that workflow code may not
    load itself (R1). Uses ``Deps.hidden_eval_fn`` -- fails closed outside
    ``BAKUDO_ENV=dev`` until a first-class abox hidden-test runner lands
    (see :data:`HIDDEN_EVAL_REMEDIATION`).
    """
    from ..trials import hidden
    from ..trials.runner import compute_hack_flags

    registry = DEPS.scenario_registry_fn()
    scenario = registry.get(input["scenario"])
    runner: TestRunner = DEPS.hidden_eval_fn

    outcome = hidden.evaluate(scenario, input.get("diff") or "", input["seed"], runner)
    flags = compute_hack_flags(
        input.get("changed_files") or [], input.get("denied_commands") or [], scenario.spec.expect
    )
    actual_status = input.get("actual_status")
    expected_status = scenario.spec.expect.status
    return {
        "f2p_rate": outcome.f2p_rate,
        "p2p_rate": outcome.p2p_rate,
        "reward": outcome.reward,
        "detail": outcome.detail,
        "expected_status": expected_status,
        "actual_status": actual_status,
        "status_match": actual_status == expected_status,
        "hack_flags": flags.model_dump(),
    }


def persist_trial(record: dict) -> None:
    """Record an (immutable) TrialRecord (experiment substrate design doc
    section 6). Idempotent (F4 fix): ``ledger.record_trial`` treats a
    duplicate id as a no-op rather than raising, so a Temporal at-least-once
    retry of this activity (e.g. after a lost activity completion wedges
    ``TrialWorkflow``, and ``ExperimentWorkflow`` separately synthesizes a
    failed record for the same trial) can never double-count a trial's
    stats."""
    trial = TrialRecord.model_validate(record)
    DEPS.ledger.record_trial(trial)


def persist_experiment(input: dict) -> None:
    """Record or update an experiment row (experiment substrate design doc
    section 7). ``status="running"`` records the initial row (idempotent);
    any other status updates it to its terminal result, mirroring
    ``run_experiment``'s ``record_experiment``/``update_experiment_result``
    calls."""
    ledger = DEPS.ledger
    status = input["status"]
    if status == "running":
        ledger.record_experiment(
            input["experiment_id"], input["name"], input["spec"], status
        )
    else:
        ledger.update_experiment_result(
            input["experiment_id"], status, input.get("result") or {}
        )


def analyze_experiment(input: dict) -> dict:
    """Assemble the experiment result over its recorded trials (Task 10's
    :func:`bakudo.experiments.runner.assemble_result`), fetching trials from
    the ledger rather than threading every ``TrialRecord`` back through the
    workflow -- ``ExperimentWorkflow`` already persisted each one via
    ``persist_trial`` (or, for a crashed child, a synthesized failed record)
    before calling this.
    """
    from ..experiments.models import ExperimentSpec
    from ..experiments.runner import assemble_result

    spec = ExperimentSpec.model_validate(input["spec"])
    registry = DEPS.scenario_registry_fn()
    trials = DEPS.ledger.list_trials(input["experiment_id"])
    scenarios = [
        registry.get(f"{d['name']}@{d['version']}") for d in input["scenarios"]
    ]
    return assemble_result(spec, trials, scenarios=scenarios, registry=registry)
