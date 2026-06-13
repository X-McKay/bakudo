"""A synchronous run pipeline mirroring :class:`AgentRunWorkflow`.

This executes the full lifecycle (section 12.1) in-process: render bundle ->
run sandbox -> collect -> evaluate. It is what the CLI/demo use and what the
Temporal workflow's activities ultimately call, so the behaviour is identical
whether or not a Temporal cluster is present.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from .. import ids
from ..abox.local import local_sandbox
from ..abox.runner import AboxOutcome
from ..agent_spec import AgentSpec
from ..bundle import Budget, TaskBundle
from ..curriculum.objective import Objective
from ..evals import EvalContext, EvalResult, Scorecard, run_default_suite
from ..registry import InMemoryLedger, RunPhase, RunRecord
from ..registry.ledger import Ledger
from ..runner.result import RunResult

SandboxFn = Callable[[TaskBundle], AboxOutcome]


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
    workflow_id: str | None = None,
) -> PipelineResult:
    """Run one objective with one agent spec, end to end."""
    ledger = ledger or InMemoryLedger()
    sandbox = sandbox or local_sandbox
    run_id = ids.run_id()

    bundle = TaskBundle(
        run_id=run_id,
        objective_id=objective.id,
        objective=objective,
        agent_spec=spec,
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

    result = RunResult.model_validate(outcome.result)

    ledger.set_phase(run_id, RunPhase.evaluating)
    ctx = EvalContext(result=result, objective=objective, diff=outcome.diff)
    eval_results = run_default_suite(ctx)
    for r in eval_results:
        ledger.record_eval(r)
    scorecard = Scorecard.from_results(eval_results)

    ledger.finish_run(run_id, RunPhase.completed, outcome.result)
    return PipelineResult(
        run_id, RunPhase.completed, result, eval_results, scorecard, outcome
    )
