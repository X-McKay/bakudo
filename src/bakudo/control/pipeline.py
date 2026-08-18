"""A synchronous run pipeline mirroring :class:`AgentRunWorkflow`.

This executes the full lifecycle (section 12.1) in-process: render bundle ->
run sandbox -> collect -> evaluate. It is what the CLI/demo use and mirrors the
Temporal ``AgentRunWorkflow``. The two share the same building blocks and the
same eval assembler (:func:`assemble_suite`, TMP-22); they differ in exactly
one, explicit way: the Temporal path assembles the sandboxed ``critic`` suite
(it runs with a live sandbox+model) while this offline mirror does not, and
canary graduation is invoked only from the Temporal completion path. Aside from
those documented differences the scorecards match.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from .. import ids
from ..abox.local import local_sandbox
from ..abox.runner import AboxOutcome
from ..agent_run_bundle import AgentRunBundle, budget_from_spec
from ..agent_spec import AgentSpec
from ..curriculum.objective import Objective
from ..evals import EvalContext, EvalResult, Scorecard, assemble_suite
from ..observability import (
    NOOP_SPAN_SINK,
    SpanAttribute,
    SpanName,
    SpanSink,
    phase_span,
)
from ..registry import InMemoryLedger, RunEvent, RunPhase, RunRecord
from ..registry.ledger import Ledger
from ..runner.result import RunResult

SandboxFn = Callable[[AgentRunBundle], AboxOutcome]


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
    run_id: str | None = None,
    span_sink: SpanSink = NOOP_SPAN_SINK,
) -> PipelineResult:
    """Run one objective with one agent spec, end to end.

    ``run_id`` may be supplied by the caller (the spawn path mints it before
    spec resolution so canary routing is deterministic per run, design §2).
    """
    resolved_ledger = ledger or InMemoryLedger()
    resolved_sandbox = sandbox or local_sandbox
    resolved_run_id = run_id or ids.run_id()
    with phase_span(
        SpanName.RUN,
        sink=span_sink,
        attributes={
            SpanAttribute.RUN_ID: resolved_run_id,
            SpanAttribute.OBJECTIVE_ID: objective.id,
        },
    ) as active:
        result = _run_objective_impl(
            objective,
            spec,
            ledger=resolved_ledger,
            sandbox=resolved_sandbox,
            workflow_id=workflow_id,
            run_id=resolved_run_id,
            span_sink=span_sink,
        )
        active.set_attribute(SpanAttribute.STATUS, result.phase.value)
        return result


def _run_objective_impl(
    objective: Objective,
    spec: AgentSpec,
    *,
    ledger: Ledger,
    sandbox: SandboxFn,
    workflow_id: str | None,
    run_id: str,
    span_sink: SpanSink,
) -> PipelineResult:
    """Execute a pre-resolved run inside the public run span."""

    with phase_span(
        SpanName.BUNDLE_RENDER,
        sink=span_sink,
        attributes={SpanAttribute.RUN_ID: run_id},
    ):
        bundle = AgentRunBundle(
            run_id=run_id,
            objective_id=objective.id,
            objective=objective,
            agent_spec=spec,
            budget=budget_from_spec(spec),
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
    with phase_span(
        SpanName.SANDBOX_PREPARE,
        sink=span_sink,
        attributes={SpanAttribute.RUN_ID: run_id},
    ) as active:
        outcome = sandbox(bundle)
        active.set_attribute(
            SpanAttribute.STATUS, "completed" if outcome.succeeded else "failed"
        )
    ledger.set_phase(run_id, RunPhase.collecting_artifacts)

    if not outcome.succeeded or outcome.result is None:
        ledger.finish_run(run_id, RunPhase.failed, outcome.result)
        # Keep the failed result's own diagnosis (summary, blocked_reasons)
        # when it parses — callers like the optimize loop surface it (OPT-12).
        failed_result: RunResult | None = None
        if isinstance(outcome.result, dict):
            try:
                failed_result = RunResult.model_validate(outcome.result)
            except Exception:  # noqa: BLE001 - diagnostics are best-effort
                failed_result = None
        return PipelineResult(run_id, RunPhase.failed, failed_result, [], None, outcome)

    with phase_span(
        SpanName.REPORT_EXTRACT,
        sink=span_sink,
        attributes={SpanAttribute.RUN_ID: run_id},
    ):
        result = RunResult.model_validate(outcome.result)

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
    )
    # Same assembler as the Temporal path (TMP-22), with the critic omitted:
    # the in-process pipeline is the offline mirror and has no live sandbox+model
    # to review with. The base (objective-type-aware) suite is identical; the
    # only difference from the Temporal path is the availability-gated critic.
    with phase_span(
        SpanName.VERIFIER_RUN,
        sink=span_sink,
        attributes={SpanAttribute.RUN_ID: run_id},
    ):
        eval_results = assemble_suite(ctx, with_critic=False)
    for r in eval_results:
        ledger.record_eval(r)
    scorecard = Scorecard.from_results(eval_results)

    ledger.finish_run(run_id, RunPhase.completed, outcome.result)
    return PipelineResult(run_id, RunPhase.completed, result, eval_results, scorecard, outcome)
