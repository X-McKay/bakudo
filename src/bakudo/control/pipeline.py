"""The run-pipeline core, plus the synchronous in-process driver (§12.1).

The lifecycle phases — build bundle -> run sandbox -> enforce budgets ->
grade -> record — live here as single-site functions. Two drivers sequence
them:

* :func:`run_objective` (this module) runs everything in-process; used by the
  CLI, the API, and :class:`~bakudo.control.tools.MetaAgentTools`.
* The Temporal activities (:mod:`bakudo.temporal._impl`) call the same
  functions one phase at a time, adding durability between phases.

Because both drivers share these functions, the eval context, the schema
gate, and the sandbox-budget enforcement cannot diverge between the offline
and durable paths.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Any

from .. import ids
from ..abox.runner import AboxOutcome
from ..abox.select import SandboxFn, resolve_sandbox
from ..agent_spec import AgentSpec
from ..bundle import Budget, MemoryExcerpt, TaskBundle
from ..curriculum.objective import Objective
from ..evals import EvalContext, EvalResult, Scorecard, run_suite
from ..log import bound_run, get_logger
from ..memory.retrieval import retrieve_excerpts
from ..registry import InMemoryLedger, RunEvent, RunPhase, RunRecord
from ..registry.ledger import Ledger
from ..runner.result import RunResult, normalize_result
from ..schema import is_valid

log = get_logger(__name__)


@dataclass
class PipelineResult:
    run_id: str
    phase: RunPhase
    result: RunResult | None
    eval_results: list[EvalResult]
    scorecard: Scorecard | None
    outcome: AboxOutcome


@dataclass
class GradedRun:
    """The output of :func:`grade_run`: normalised result + suite verdicts."""

    result: RunResult
    eval_results: list[EvalResult]
    scorecard: Scorecard
    schema_valid: bool


def build_bundle(
    objective: Objective,
    spec: AgentSpec,
    *,
    run_id: str,
    memory: Any | None = None,
    memory_excerpts: list[MemoryExcerpt] | None = None,
    timeout_seconds: int | None = None,
) -> TaskBundle:
    """Render the task bundle for one run (§5.3), including the memory read
    path: unless excerpts were supplied, relevant memories are retrieved and
    shipped inside the bundle for the sandboxed worker's query-memory tool."""
    excerpts = memory_excerpts or retrieve_excerpts(memory, objective)
    return TaskBundle(
        run_id=run_id,
        objective_id=objective.id,
        objective=objective,
        agent_spec=spec,
        memory_excerpts=excerpts,
        budget=Budget(timeoutSeconds=timeout_seconds or spec.sandbox.timeout_seconds),
    )


def enforce_sandbox_budgets(spec: AgentSpec, outcome: AboxOutcome) -> AboxOutcome:
    """Enforce the spec's declared sandbox budgets on a finished run (§8).

    ``sandbox.maxChangedFiles`` and ``sandbox.maxDiffBytes`` are hard limits,
    not suggestions: a run that exceeds them is marked failed with explicit
    blocked reasons, on both the sync and Temporal paths.
    """
    limits = spec.sandbox
    changed = outcome.changed_files or (outcome.result or {}).get("changed_files", [])
    diff_bytes = len(outcome.diff.encode("utf-8", errors="replace"))

    violations: list[str] = []
    if limits.max_changed_files is not None and len(changed) > limits.max_changed_files:
        violations.append(
            f"sandbox_budget:changed_files {len(changed)} > {limits.max_changed_files}"
        )
    if limits.max_diff_bytes is not None and diff_bytes > limits.max_diff_bytes:
        violations.append(
            f"sandbox_budget:diff_bytes {diff_bytes} > {limits.max_diff_bytes}"
        )
    if not violations:
        return outcome

    result = dict(outcome.result or {})
    result["status"] = "failed"
    result["blocked_reasons"] = [*result.get("blocked_reasons", []), *violations]
    return replace(outcome, exit_code=1, result=result)


def grade_run(
    objective: Objective,
    raw_result: dict,
    *,
    ledger: Ledger,
    run_id: str,
    agent: str = "",
    diff: str = "",
    denied_commands: list[dict[str, str]] | None = None,
    runtime_seconds: float = 0.0,
    tokens_used: int = 0,
    schema_valid_hint: bool = True,
    token_budget: int | None = None,
    time_budget_s: float | None = None,
) -> GradedRun:
    """Grade one run: schema-validate, normalise, run the suite, record.

    The *only* place an :class:`EvalContext` is constructed for a run — the
    raw worker output is validated against ``result.schema.json`` at the
    trust boundary (so the schema gate can fail), then normalised forgivingly
    so the rest of the suite still grades malformed output.
    """
    schema_valid = schema_valid_hint and is_valid(raw_result, "result.schema.json")
    result = normalize_result(
        raw_result,
        run_id=run_id,
        agent=agent or str(raw_result.get("agent") or "unknown"),
        objective_id=objective.id,
    )
    ctx = EvalContext(
        result=result,
        objective=objective,
        diff=diff,
        denied_commands=denied_commands or [],
        runtime_seconds=runtime_seconds,
        tokens_used=tokens_used,
        schema_valid=schema_valid,
        token_budget=token_budget,
        time_budget_s=time_budget_s,
    )
    # Suite selection keys off the objective type (optimize adds perf/simplicity).
    eval_results = run_suite(ctx)
    for r in eval_results:
        ledger.record_eval(r)
    return GradedRun(
        result=result,
        eval_results=eval_results,
        scorecard=Scorecard.from_results(eval_results),
        schema_valid=schema_valid,
    )


def run_objective(
    objective: Objective,
    spec: AgentSpec,
    *,
    ledger: Ledger | None = None,
    sandbox: SandboxFn | None = None,
    memory: Any | None = None,
    workflow_id: str | None = None,
    run_id: str | None = None,
) -> PipelineResult:
    """Run one objective with one agent spec, end to end.

    Sandbox selection fails closed: without an explicit ``sandbox`` callable,
    :func:`~bakudo.abox.select.resolve_sandbox` requires ``BAKUDO_SANDBOX``
    (or offline mode) rather than silently running in-process. ``run_id`` may
    be pre-allocated by callers that need to hand it out before the run
    starts (the async API path).
    """
    ledger = ledger or InMemoryLedger()
    sandbox = resolve_sandbox(sandbox)
    run_id = run_id or ids.run_id()

    with bound_run(run_id):
        return _run_objective_bound(
            objective, spec, ledger=ledger, sandbox=sandbox, memory=memory,
            workflow_id=workflow_id, run_id=run_id,
        )


def _run_objective_bound(
    objective: Objective,
    spec: AgentSpec,
    *,
    ledger: Ledger,
    sandbox: SandboxFn,
    memory: Any | None,
    workflow_id: str | None,
    run_id: str,
) -> PipelineResult:
    log.info(
        "run started",
        extra={"context": {"agent": spec.ref, "objective_id": objective.id}},
    )
    bundle = build_bundle(objective, spec, run_id=run_id, memory=memory)

    ledger.create_run(
        RunRecord(
            id=run_id,
            temporal_workflow_id=workflow_id or f"run-{run_id}",
            abox_task_id=run_id,
            objective_id=objective.id,
            agent_ref=spec.ref,
            git_branch=ids.git_branch_for(run_id),
        )
    )

    ledger.set_phase(run_id, RunPhase.bundle_rendered)
    ledger.set_phase(run_id, RunPhase.agent_running)
    outcome = enforce_sandbox_budgets(spec, sandbox(bundle))
    ledger.set_phase(run_id, RunPhase.collecting_artifacts)

    if not outcome.succeeded or outcome.result is None:
        ledger.finish_run(run_id, RunPhase.failed, outcome.result)
        log.warning(
            "run failed",
            extra={"context": {"exit_code": outcome.exit_code}},
        )
        return PipelineResult(run_id, RunPhase.failed, None, [], None, outcome)

    ledger.set_phase(run_id, RunPhase.evaluating)
    if outcome.observability:
        ledger.append_event(
            RunEvent(run_id=run_id, event_type="observability", payload=outcome.observability)
        )
    graded = grade_run(
        objective,
        outcome.result,
        ledger=ledger,
        run_id=run_id,
        agent=spec.ref,
        diff=outcome.diff,
        denied_commands=outcome.denied_commands,
        runtime_seconds=outcome.runtime_seconds,
        tokens_used=outcome.tokens_used,
        token_budget=bundle.budget.max_tokens,
        time_budget_s=float(bundle.budget.timeout_seconds),
    )

    ledger.finish_run(run_id, RunPhase.completed, outcome.result)
    log.info(
        "run completed",
        extra={"context": {"overall_score": graded.scorecard.overall_score}},
    )
    return PipelineResult(
        run_id,
        RunPhase.completed,
        graded.result,
        graded.eval_results,
        graded.scorecard,
        outcome,
    )
