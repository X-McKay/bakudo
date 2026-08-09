"""Temporal workflow definitions (spec sections 11, 12).

Requires the ``temporal`` extra (``temporalio``). Workflows are deterministic
orchestration only; every side effect goes through an activity
(:mod:`bakudo.temporal.activities`).

Implemented here:

* :class:`AgentRunWorkflow` — the full run lifecycle of section 12.1.
* :class:`EvalWorkflow` — runs the eval suite against a collected run.
* :class:`MetaAgentWorkflow` — the long-running entity workflow (section 11.3)
  with Signals, Queries, and Updates (section 11.4) and Continue-As-New.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any

from temporalio import workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ActivityError, ChildWorkflowError

with workflow.unsafe.imports_passed_through():
    from ..control.optimize import (
        attempt_objective,
        round_feedback,
        scout_objective,
        select_winner,
    )
    from .activities import (
        collect_signals,
        compact_memories,
        create_run,
        load_agent_spec,
        persist_run,
        render_bundle,
        run_agent_evolution,
        run_eval_suite,
        run_sandbox,
    )
    from .client import META_WORKFLOW_ID
    from .shared import (
        AgentRunInput,
        AgentRunOutput,
        CompactionInput,
        EvalInput,
        EvolutionInput,
        ObserveInput,
        OptimizeInput,
        resolve_agent_name,
    )

# Activities that touch the network/model get generous timeouts; ledger writes
# are quick. All are retried with backoff. Typed as dict[str, Any] so the
# **-splat unifies with execute_activity's keyword overloads under mypy.
_LONG: dict[str, Any] = dict(
    start_to_close_timeout=timedelta(hours=2),
    retry_policy=RetryPolicy(maximum_attempts=3),
)
_SHORT: dict[str, Any] = dict(
    start_to_close_timeout=timedelta(seconds=30),
    retry_policy=RetryPolicy(maximum_attempts=5),
)


@workflow.defn
class EvalWorkflow:
    @workflow.run
    async def run(self, inp: EvalInput) -> dict:
        return await workflow.execute_activity(run_eval_suite, inp, **_LONG)


@workflow.defn
class AgentRunWorkflow:
    """Runs one agent spec against one objective in one sandbox (section 12)."""

    def __init__(self) -> None:
        self._phase = "created"
        self._cancelled = False

    @workflow.signal
    def cancel(self) -> None:
        self._cancelled = True

    @workflow.query
    def phase(self) -> str:
        return self._phase

    async def _advance(self, run_id: str, phase: str, payload: dict | None = None) -> None:
        self._phase = phase
        await workflow.execute_activity(
            persist_run, args=[run_id, phase, payload or {}], **_SHORT
        )

    async def _notify_meta(self, run_id: str) -> None:
        """Signal run_completed to the meta workflow so active_runs drains (TMP-5).

        Guard: only when this run was dispatched *by* the meta workflow — the
        parent workflow id is deterministic workflow state, so this needs no
        input flag and cannot misfire for CLI/API-started runs. Best-effort:
        a missing/closed meta singleton must not fail a finished run.
        """
        parent = workflow.info().parent
        if parent is None or parent.workflow_id != META_WORKFLOW_ID:
            return
        try:
            handle = workflow.get_external_workflow_handle(META_WORKFLOW_ID)
            await handle.signal("run_completed", run_id)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - best-effort notification
            workflow.logger.warning(
                "run_completed signal to %s failed: %s", META_WORKFLOW_ID, exc
            )

    @workflow.run
    async def run(self, inp: AgentRunInput) -> AgentRunOutput:
        try:
            return await self._run_lifecycle(inp)
        except (ActivityError, ChildWorkflowError) as err:
            # TMP-10: retry exhaustion must not leave the ledger stuck at a
            # non-terminal phase forever — record a terminal failed phase (and
            # its finished event) best-effort, then let the workflow fail.
            cause = getattr(err, "cause", None) or err
            try:
                await self._advance(inp.run_id, "failed", {"error": str(cause)})
            except (ActivityError, ChildWorkflowError) as persist_err:
                workflow.logger.warning(
                    "could not persist terminal failed phase for %s: %s",
                    inp.run_id, persist_err,
                )
            await self._notify_meta(inp.run_id)
            raise

    async def _run_lifecycle(self, inp: AgentRunInput) -> AgentRunOutput:
        workflow_id = workflow.info().workflow_id
        await workflow.execute_activity(
            create_run, args=[inp, workflow_id], **_SHORT
        )
        self._phase = "created"

        bundle = await workflow.execute_activity(render_bundle, inp, **_SHORT)
        await self._advance(inp.run_id, "bundle_rendered")

        if self._cancelled:
            await self._advance(inp.run_id, "cancelled")
            await self._notify_meta(inp.run_id)
            return AgentRunOutput(inp.run_id, "cancelled", "", "")

        await self._advance(inp.run_id, "sandbox_starting")
        await self._advance(inp.run_id, "agent_running")
        sandbox = await workflow.execute_activity(run_sandbox, bundle, **_LONG)

        await self._advance(inp.run_id, "collecting_artifacts")
        result = sandbox.get("result")
        if not sandbox.get("succeeded") or result is None:
            await self._advance(inp.run_id, "failed", {"result": result})
            await self._notify_meta(inp.run_id)
            return AgentRunOutput(
                inp.run_id, "failed",
                bundle["agent_spec"]["metadata"]["name"], sandbox.get("git_branch", ""),
                result=result,
            )

        await self._advance(inp.run_id, "evaluating")
        eval_out = await workflow.execute_child_workflow(
            EvalWorkflow.run,
            EvalInput(
                run_id=inp.run_id,
                objective=inp.objective,
                result=result,
                diff=sandbox.get("diff", ""),
                denied_commands=sandbox.get("denied_commands", []),
                runtime_seconds=sandbox.get("runtime_seconds", 0.0),
                tokens_used=sandbox.get("tokens_used", 0),
                schema_valid=True,
            ),
            id=f"eval-{inp.run_id}",
        )

        await self._advance(inp.run_id, "completed", {"result": result})
        await self._notify_meta(inp.run_id)
        return AgentRunOutput(
            run_id=inp.run_id,
            phase="completed",
            agent_ref=f"{bundle['agent_spec']['metadata']['name']}@"
            f"{bundle['agent_spec']['metadata']['version']}",
            git_branch=sandbox.get("git_branch", ""),
            result=result,
            scorecard=eval_out.get("scorecard"),
            eval_results=eval_out.get("eval_results", []),
        )


@workflow.defn
class OptimizationWorkflow:
    """Scout → parallel single-hypothesis attempts → winner, looping with
    feedback (spec sections 11, 15).

    The control plane owns the fan-out: the untrusted worker plane never
    schedules its own sub-agents. Each attempt runs in its own sandbox on its
    own branch, so candidates are directly comparable and the winning diff is
    already host-reviewable. Returning ``no-change`` after exhausting the
    round budget is a success outcome, not a failure.
    """

    def __init__(self) -> None:
        self._round = 0
        self._phase = "created"

    @workflow.query
    def status(self) -> dict:
        return {"round": self._round, "phase": self._phase}

    async def _child_run(self, objective: dict, spec: dict, timeout: int) -> dict:
        run_id = workflow.uuid4().hex
        handle = await workflow.start_child_workflow(
            AgentRunWorkflow.run,
            AgentRunInput(
                run_id=run_id,
                objective=objective,
                agent_spec=spec,
                timeout_seconds=timeout,
            ),
            id=f"run-{run_id}",
        )
        out = await handle
        return out if isinstance(out, dict) else _as_dict(out)

    @workflow.run
    async def run(self, inp: OptimizeInput) -> dict:
        feedback: list[str] = []
        while self._round < inp.max_rounds:
            self._round += 1

            self._phase = "scouting"
            scout = await self._child_run(
                scout_objective(inp.objective, feedback=feedback),
                inp.scout_spec,
                inp.timeout_seconds,
            )
            scout_result = scout.get("result") or {}
            approaches = list(
                scout_result.get("proposed_followups", [])
            )[: inp.max_approaches]
            if not approaches:
                # The scout found nothing worth trying — a valid outcome.
                self._phase = "no-change"
                return {
                    "status": "no-change",
                    "rounds_used": self._round,
                    "reason": "scout proposed no approaches",
                }

            self._phase = "attempting"
            attempts = await asyncio.gather(
                *(
                    self._child_run(
                        attempt_objective(inp.objective, approach=a, index=i),
                        inp.attempt_spec,
                        inp.timeout_seconds,
                    )
                    for i, a in enumerate(approaches)
                )
            )

            self._phase = "selecting"
            winner = select_winner(list(attempts))
            if winner is not None:
                self._phase = "improved"
                return {
                    "status": "improved",
                    "rounds_used": self._round,
                    "winner_run_id": winner.get("run_id"),
                    "git_branch": winner.get("git_branch"),
                    "scorecard": winner.get("scorecard"),
                    "result": winner.get("result"),
                }
            feedback = round_feedback(list(attempts))

        self._phase = "no-change"
        return {
            "status": "no-change",
            "rounds_used": self._round,
            "reason": "no attempt cleared the gates",
            "feedback": feedback,
        }


def _as_dict(out: AgentRunOutput) -> dict:
    return {
        "run_id": out.run_id,
        "phase": out.phase,
        "agent_ref": out.agent_ref,
        "git_branch": out.git_branch,
        "result": out.result,
        "scorecard": out.scorecard,
        "eval_results": out.eval_results,
    }


# --- Long-running meta-agent entity workflow (section 11.3) ---

# Continue-As-New after this many handled events keeps history bounded.
_CONTINUE_AS_NEW_THRESHOLD = 500


@dataclass
class MetaState:
    """Durable high-level state (section 11.3)."""

    mode: str = "sandbox-autonomous"  # observe|propose|sandbox-autonomous|low-risk|full
    active_objectives: list[dict[str, Any]] = field(default_factory=list)
    active_runs: list[str] = field(default_factory=list)
    pending_promotions: list[dict[str, Any]] = field(default_factory=list)
    role_concurrency: dict[str, int] = field(default_factory=lambda: {"add-feature": 2})
    budget_usd_remaining: float = 100.0
    processed_objectives: int = 0
    # Undispatched backlog carried across Continue-As-New boundaries.
    pending_backlog: list[dict[str, Any]] = field(default_factory=list)
    # Objectives that could not be dispatched (no resolvable agent spec):
    # parked with a reason instead of crashing the workflow task (TMP-3).
    dead_letter: list[dict[str, Any]] = field(default_factory=list)
    # History-roll threshold; part of the carried state so tests (and
    # operators) can lower it without patching module globals.
    continue_as_new_threshold: int = _CONTINUE_AS_NEW_THRESHOLD


@workflow.defn
class MetaAgentWorkflow:
    """The control-plane intelligence as a durable entity workflow."""

    def __init__(self) -> None:
        self._state = MetaState()
        self._backlog: list[dict[str, Any]] = []
        self._handled = 0
        self._paused = False

    # --- Signals (async events, section 11.4) ---
    @workflow.signal
    def new_objective(self, objective: dict[str, Any]) -> None:
        self._backlog.append(objective)

    @workflow.signal
    def run_completed(self, run_id: str) -> None:
        if run_id in self._state.active_runs:
            self._state.active_runs.remove(run_id)
        self._state.processed_objectives += 1

    @workflow.signal
    def pause_autonomy(self) -> None:
        self._paused = True

    @workflow.signal
    def resume_autonomy(self) -> None:
        self._paused = False

    # --- Queries (read-only dashboard inspection, section 11.4) ---
    @workflow.query
    def get_status(self) -> dict[str, Any]:
        return {
            "mode": self._state.mode,
            "paused": self._paused,
            "backlog": len(self._backlog),
            "active_runs": list(self._state.active_runs),
            "pending_promotions": len(self._state.pending_promotions),
            "budget_usd_remaining": self._state.budget_usd_remaining,
            "processed_objectives": self._state.processed_objectives,
            "dead_letter": len(self._state.dead_letter),
        }

    @workflow.query
    def get_backlog(self) -> list[dict[str, Any]]:
        return list(self._backlog)

    @workflow.query
    def get_dead_letter(self) -> list[dict[str, Any]]:
        return list(self._state.dead_letter)

    # --- Updates (validated state changes returning a result, section 11.4) ---
    @workflow.update
    def submit_objective(self, objective: dict[str, Any]) -> str:
        self._backlog.append(objective)
        return objective.get("id", "")

    @submit_objective.validator
    def _validate_submit(self, objective: dict[str, Any]) -> None:
        if "id" not in objective or "type" not in objective:
            raise ValueError("objective requires 'id' and 'type'")

    @workflow.update
    def change_budget(self, usd: float) -> float:
        self._state.budget_usd_remaining = usd
        return usd

    @workflow.update
    def change_concurrency_limit(self, role: str, limit: int) -> dict[str, int]:
        self._state.role_concurrency[role] = limit
        return dict(self._state.role_concurrency)

    def _can_dispatch(self) -> bool:
        # observe = signals only; propose = human approval required before runs.
        return (
            not self._paused
            and self._state.mode not in ("observe", "propose")
            and bool(self._backlog)
        )

    @workflow.run
    async def run(self, carried: MetaState | None = None) -> None:
        if carried is not None:
            self._state = carried
            # Restore any backlog carried across the Continue-As-New boundary.
            self._backlog = list(carried.pending_backlog)
            self._state.pending_backlog = []

        while True:
            # Wake only when there is dispatchable work or it is time to roll
            # history. Backlog is never dropped while paused/observing.
            await workflow.wait_condition(
                lambda: self._can_dispatch()
                or self._handled >= self._state.continue_as_new_threshold
            )
            if self._handled >= self._state.continue_as_new_threshold:
                # Carry the full state, including any undispatched backlog.
                self._state.pending_backlog = list(self._backlog)
                workflow.continue_as_new(self._state)

            objective = self._backlog.pop(0)
            self._handled += 1

            # Resolve the agent spec (TMP-3): an inline agent_spec wins, then
            # suggestedAgents[0] / the per-type default, loaded via activity.
            # Unresolvable objectives are dead-lettered, never crash the task.
            spec = objective.get("agent_spec")
            if not isinstance(spec, dict):
                spec = None
                agent_name = resolve_agent_name(objective)
                if agent_name is not None:
                    spec = await workflow.execute_activity(
                        load_agent_spec, agent_name, **_SHORT
                    )
                if not isinstance(spec, dict):
                    reason = (
                        f"no agent spec resolvable (agent={agent_name!r}, "
                        f"type={objective.get('type')!r}, "
                        f"suggestedAgents={objective.get('suggestedAgents')!r})"
                    )
                    workflow.logger.warning(
                        "dead-lettering objective %s: %s", objective.get("id"), reason
                    )
                    self._state.dead_letter.append(
                        {"objective": objective, "reason": reason}
                    )
                    continue

            run_id = objective.get("run_id") or workflow.uuid4().hex
            self._state.active_runs.append(run_id)

            # Dispatch the run as a child workflow; the meta-agent does not block
            # on it — completion arrives via the run_completed signal. ABANDON
            # keeps in-flight runs alive across Continue-As-New (TMP-6): the
            # parent "closing" to roll history must not kill a 2h sandbox run.
            await workflow.start_child_workflow(
                AgentRunWorkflow.run,
                AgentRunInput(
                    run_id=run_id,
                    objective=objective,
                    agent_spec=spec,
                ),
                id=f"run-{run_id}",
                parent_close_policy=workflow.ParentClosePolicy.ABANDON,
            )


# --- Evolution & curriculum workflows (spec sections 11.1, 15, 16) ---

@workflow.defn
class AgentEvolutionWorkflow:
    """Propose, test, compare, and decide an agent spec change (section 15)."""

    @workflow.run
    async def run(self, inp: EvolutionInput) -> dict:
        return await workflow.execute_activity(run_agent_evolution, inp, **_LONG)


@workflow.defn
class MemoryCompactionWorkflow:
    """Convert a run's emitted memories into durable, vetted memories (section 14)."""

    @workflow.run
    async def run(self, inp: CompactionInput) -> dict:
        return await workflow.execute_activity(compact_memories, inp, **_SHORT)


@workflow.defn
class RepoObserverWorkflow:
    """Watch a repo and emit candidate objectives to the meta-agent (section 16).

    Runs as a periodic loop: collect signals, signal each candidate objective to
    the singleton MetaAgentWorkflow, sleep, then Continue-As-New to bound
    history.
    """

    @workflow.run
    async def run(self, inp: ObserveInput) -> None:
        objectives = await workflow.execute_activity(collect_signals, inp, **_SHORT)
        meta = workflow.get_external_workflow_handle(META_WORKFLOW_ID)
        for objective in objectives:
            await meta.signal("new_objective", objective)

        # Poll on an interval; cap iterations per execution to keep history
        # small. The counter rides on the input (continue_as_new takes exactly
        # the workflow's run arguments) and resets when it rolls over.
        await workflow.sleep(timedelta(minutes=15))
        next_iterations = 0 if inp.iterations >= 32 else inp.iterations + 1
        workflow.continue_as_new(ObserveInput(repo=inp.repo, iterations=next_iterations))
