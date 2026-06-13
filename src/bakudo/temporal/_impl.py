"""Plain (SDK-free) implementations behind the Temporal activities.

Keeping the logic here means it is exercised by unit tests without a Temporal
worker. A process-global :class:`Deps` bundle lets the worker inject the real
ledger and sandbox driver; tests use the in-memory defaults.
"""

from __future__ import annotations

import os
from collections.abc import Callable
from dataclasses import dataclass, field

from ..abox.local import local_sandbox
from ..abox.runner import AboxOutcome, AboxRunner
from ..agent_spec import parse_spec
from ..bundle import Budget, MemoryExcerpt, TaskBundle
from ..curriculum.objective import Objective
from ..evals import EvalContext, Scorecard, decide, run_default_suite
from ..evals.promotion import PromotionPolicy
from ..registry import InMemoryLedger, RunPhase
from .shared import AgentRunInput, EvalInput, PromotionInput

SandboxFn = Callable[[TaskBundle], AboxOutcome]


@dataclass
class Deps:
    """Injectable dependencies for the activity implementations."""

    ledger: object = field(default_factory=InMemoryLedger)
    sandbox: SandboxFn | None = None

    def sandbox_fn(self) -> SandboxFn:
        if self.sandbox is not None:
            return self.sandbox
        # Default: local in-process sandbox unless a real abox is requested.
        if os.environ.get("BAKUDO_USE_ABOX") == "1":
            runner = AboxRunner()
            return runner.run
        return local_sandbox


DEPS = Deps()


def configure(*, ledger: object | None = None, sandbox: SandboxFn | None = None) -> None:
    """Inject real dependencies (called by the worker entrypoint)."""
    if ledger is not None:
        DEPS.ledger = ledger
    if sandbox is not None:
        DEPS.sandbox = sandbox


def _bundle_from_input(inp: AgentRunInput) -> TaskBundle:
    return TaskBundle(
        run_id=inp.run_id,
        objective_id=inp.objective["id"],
        objective=Objective.model_validate(inp.objective),
        agent_spec=parse_spec(inp.agent_spec),
        memory_excerpts=[MemoryExcerpt.model_validate(m) for m in inp.memory_excerpts],
        eval_rubric=inp.eval_rubric,
        budget=Budget(timeoutSeconds=inp.timeout_seconds),
    )


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
        "succeeded": outcome.succeeded,
    }


def persist_run(run_id: str, phase: str, payload: dict) -> None:
    ledger = DEPS.ledger
    ph = RunPhase(phase)
    # The in-memory ledger is sync; the Postgres ledger is async and is driven
    # directly from the worker, so here we only handle the sync ledger.
    if isinstance(ledger, InMemoryLedger):
        try:
            if ph.is_terminal:
                ledger.finish_run(run_id, ph, payload.get("result"))
            else:
                ledger.set_phase(run_id, ph)
        except KeyError:
            # Run not yet created in this process's ledger; nothing to update.
            pass


def run_eval_suite(inp: EvalInput) -> dict:
    from ..runner.result import RunResult

    ctx = EvalContext(
        result=RunResult.model_validate(inp.result),
        objective=Objective.model_validate(inp.objective),
        diff=inp.diff,
        denied_commands=inp.denied_commands,
        runtime_seconds=inp.runtime_seconds,
        tokens_used=inp.tokens_used,
        schema_valid=inp.schema_valid,
    )
    results = run_default_suite(ctx)
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
    return decision.to_dict()
