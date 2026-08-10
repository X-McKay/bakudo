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

with workflow.unsafe.imports_passed_through():
    from ..control.optimize import drive_optimize
    from ..curriculum.observe import fresh_objectives
    from .activities import (
        collect_signals,
        compact_memories,
        create_run,
        observe_canary_run,
        persist_run,
        render_bundle,
        resolve_agent_spec,
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
    )

# Activities that touch the network/model get generous timeouts; ledger writes
# are quick. All are retried with backoff. Typed as dict[str, Any] so the
# **-splat unifies with execute_activity's keyword overloads under mypy.
# Long activities heartbeat every HEARTBEAT_INTERVAL_SECONDS (activities.py),
# so a lost worker is detected within heartbeat_timeout — not the 2h cap —
# and the retry can land on a healthy worker promptly.
_LONG: dict[str, Any] = dict(
    start_to_close_timeout=timedelta(hours=2),
    heartbeat_timeout=timedelta(minutes=2),
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
        """Signal run completion back to the meta-agent, if it dispatched us.

        Only the meta-agent handles ``run_completed``; other parents (e.g.
        OptimizationWorkflow) await the child handle directly.
        """
        parent = workflow.info().parent
        if parent is not None and parent.workflow_id == META_WORKFLOW_ID:
            handle = workflow.get_external_workflow_handle(parent.workflow_id)
            await handle.signal("run_completed", run_id)

    @workflow.run
    async def run(self, inp: AgentRunInput) -> AgentRunOutput:
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
        budget = bundle.get("budget", {})
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
                token_budget=budget.get("maxTokens"),
                time_budget_s=float(budget["timeoutSeconds"])
                if budget.get("timeoutSeconds")
                else None,
            ),
            id=f"eval-{inp.run_id}",
        )

        await self._advance(inp.run_id, "completed", {"result": result})
        # Canary observation: if this run's agent version is a canary, its
        # scorecard may complete the observation quota (promote/roll back).
        await workflow.execute_activity(
            observe_canary_run, inp.run_id, **_SHORT
        )
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
        # The round logic and gates live in drive_optimize, shared verbatim
        # with the in-process run_optimize_loop; this workflow contributes only
        # durable child-workflow execution and parallel attempt fan-out.
        def on_phase(round_number: int, phase: str) -> None:
            self._round = round_number
            self._phase = phase

        return await drive_optimize(
            inp.objective,
            run_scout=lambda doc: self._child_run(
                doc, inp.scout_spec, inp.timeout_seconds
            ),
            run_attempt=lambda doc: self._child_run(
                doc, inp.attempt_spec, inp.timeout_seconds
            ),
            gather=asyncio.gather,
            max_rounds=inp.max_rounds,
            max_approaches=inp.max_approaches,
            on_phase=on_phase,
        )


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
    # Objective ids that could not be matched to any agent spec (dead-letter).
    unassignable: list[str] = field(default_factory=list)
    # Undispatched backlog carried across Continue-As-New boundaries.
    pending_backlog: list[dict[str, Any]] = field(default_factory=list)


# Continue-As-New after this many handled events keeps history bounded.
_CONTINUE_AS_NEW_THRESHOLD = 500


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
            "unassignable": list(self._state.unassignable),
        }

    @workflow.query
    def get_backlog(self) -> list[dict[str, Any]]:
        return list(self._backlog)

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
                lambda: self._can_dispatch() or self._handled >= _CONTINUE_AS_NEW_THRESHOLD
            )
            if self._handled >= _CONTINUE_AS_NEW_THRESHOLD:
                # Carry the full state, including any undispatched backlog.
                self._state.pending_backlog = list(self._backlog)
                workflow.continue_as_new(self._state)

            objective = self._backlog.pop(0)
            self._handled += 1

            # Resolve which agent runs this objective: an inline spec wins,
            # then the curriculum's suggestion, then the type default.
            spec = objective.get("agent_spec")
            if spec is None:
                suggested = (
                    objective.get("suggestedAgents")
                    or objective.get("suggested_agents")
                    or []
                )
                spec = await workflow.execute_activity(
                    resolve_agent_spec,
                    args=[
                        suggested[0] if suggested else None,
                        objective.get("type", ""),
                        # Canary routing key: stable per objective, so replay
                        # routes identically.
                        objective.get("id", ""),
                    ],
                    **_SHORT,
                )
            if spec is None:
                # Dead-letter rather than crash the dispatch loop; visible in
                # get_status() for the operator to triage.
                self._state.unassignable.append(objective.get("id", "<no-id>"))
                continue

            run_id = objective.get("run_id") or workflow.uuid4().hex
            self._state.active_runs.append(run_id)

            # Dispatch the run as a child workflow; the meta-agent does not block
            # on it — completion arrives via the run_completed signal. ABANDON
            # keeps in-flight runs alive across this workflow's Continue-As-New.
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

    # Objective keys remembered across Continue-As-New; bounds the carried
    # argument while covering far more objectives than one repo emits.
    _SEEN_CAP = 512

    @workflow.run
    async def run(self, inp: ObserveInput) -> None:
        objectives = await workflow.execute_activity(collect_signals, inp, **_SHORT)

        # Signal only objectives not emitted in previous cycles — an
        # unchanged repo must not refill the backlog every 15 minutes.
        fresh, seen = fresh_objectives(objectives, inp.seen)
        meta = workflow.get_external_workflow_handle(META_WORKFLOW_ID)
        for objective in fresh:
            await meta.signal("new_objective", objective)

        # Poll on an interval; cap iterations per execution to keep history
        # small. The counter and seen-set ride on the input (continue_as_new
        # takes exactly the workflow's run arguments).
        await workflow.sleep(timedelta(minutes=15))
        next_iterations = 0 if inp.iterations >= 32 else inp.iterations + 1
        workflow.continue_as_new(
            ObserveInput(
                repo=inp.repo,
                iterations=next_iterations,
                seen=seen[-self._SEEN_CAP:],
            )
        )
