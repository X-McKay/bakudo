"""A synchronous run pipeline mirroring :class:`AgentRunWorkflow`.

This executes the full lifecycle (section 12.1) in-process: render bundle ->
run sandbox -> collect -> evaluate. It is what the CLI/demo use and what the
Temporal workflow's activities ultimately call, so the behaviour is identical
whether or not a Temporal cluster is present.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .. import ids
from ..abox.runner import AboxOutcome
from ..abox.select import SandboxFn, resolve_sandbox
from ..agent_spec import AgentSpec
from ..bundle import Budget, TaskBundle
from ..curriculum.objective import Objective
from ..evals import EvalContext, EvalResult, Scorecard, run_suite
from ..memory.retrieval import retrieve_excerpts
from ..registry import InMemoryLedger, RunEvent, RunPhase, RunRecord
from ..registry.ledger import Ledger
from ..runner.result import RunResult, normalize_result
from ..schema import is_valid


@dataclass
class PipelineResult:
    run_id: str
    phase: RunPhase
    result: RunResult | None
    eval_results: list[EvalResult]
    scorecard: Scorecard | None
    outcome: AboxOutcome


def run_objective(
    objective: Objective,
    spec: AgentSpec,
    *,
    ledger: Ledger | None = None,
    sandbox: SandboxFn | None = None,
    memory: Any | None = None,
    workflow_id: str | None = None,
) -> PipelineResult:
    """Run one objective with one agent spec, end to end.

    Sandbox selection fails closed: without an explicit ``sandbox`` callable,
    :func:`~bakudo.abox.select.resolve_sandbox` requires ``BAKUDO_SANDBOX``
    (or offline mode) rather than silently running in-process.
    """
    ledger = ledger or InMemoryLedger()
    sandbox = resolve_sandbox(sandbox)
    run_id = ids.run_id()

    bundle = TaskBundle(
        run_id=run_id,
        objective_id=objective.id,
        objective=objective,
        agent_spec=spec,
        memory_excerpts=retrieve_excerpts(memory, objective),
        budget=Budget(timeoutSeconds=spec.sandbox.timeout_seconds),
    )

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
    outcome = sandbox(bundle)
    ledger.set_phase(run_id, RunPhase.collecting_artifacts)

    if not outcome.succeeded or outcome.result is None:
        ledger.finish_run(run_id, RunPhase.failed, outcome.result)
        return PipelineResult(run_id, RunPhase.failed, None, [], None, outcome)

    # Validate the *raw* worker output against the JSON Schema at the trust
    # boundary; normalisation below is forgiving, so this is what the schema
    # eval gate actually grades.
    schema_valid = is_valid(outcome.result, "result.schema.json")
    result = normalize_result(
        outcome.result, run_id=run_id, agent=spec.ref, objective_id=objective.id
    )

    ledger.set_phase(run_id, RunPhase.evaluating)
    if outcome.observability:
        ledger.append_event(
            RunEvent(run_id=run_id, event_type="observability", payload=outcome.observability)
        )
    # Thread the safety signal (denied commands) and cost signals (tokens,
    # runtime) into the eval context so the safety and cost gates are meaningful.
    ctx = EvalContext(
        result=result,
        objective=objective,
        diff=outcome.diff,
        denied_commands=outcome.denied_commands,
        runtime_seconds=outcome.runtime_seconds,
        tokens_used=outcome.tokens_used,
        schema_valid=schema_valid,
    )
    # Suite selection keys off the objective type, matching the Temporal path.
    eval_results = run_suite(ctx)
    for r in eval_results:
        ledger.record_eval(r)
    scorecard = Scorecard.from_results(eval_results)

    ledger.finish_run(run_id, RunPhase.completed, outcome.result)
    return PipelineResult(
        run_id, RunPhase.completed, result, eval_results, scorecard, outcome
    )
