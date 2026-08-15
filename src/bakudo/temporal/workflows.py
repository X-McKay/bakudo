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
from datetime import datetime, timedelta
from typing import Any

from temporalio import workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ActivityError, ChildWorkflowError

with workflow.unsafe.imports_passed_through():
    from ..control.optimize import (
        attempt_objective,
        bench_reproduces,
        round_feedback,
        scout_objective,
        scout_run_failed,
        select_winner,
    )
    from .activities import (
        check_canary_graduation,
        collect_signals,
        compact_memories,
        create_run,
        load_agent_spec,
        measure_winner_bench,
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
# run_sandbox options (TMP-12). maximum_attempts=1 is deliberate: a retried
# sandbox re-executes a non-idempotent agent run against the same
# deterministic run_id/branch (worktree + branch collision, doubled model
# spend), so failures surface as a terminal failed phase (TMP-10) for the
# control plane to re-dispatch under a fresh run_id instead. The activity
# heartbeats every 30s (activities.run_sandbox), so heartbeat_timeout detects
# a crashed worker in minutes rather than after the 2h start-to-close.
_SANDBOX: dict[str, Any] = dict(
    start_to_close_timeout=timedelta(hours=2),
    heartbeat_timeout=timedelta(minutes=5),
    retry_policy=RetryPolicy(maximum_attempts=1),
)


class _MalformedSpec(Exception):
    """Raised when a rendered bundle's agent spec lacks a usable
    name/version (TMP-20). Caught inside AgentRunWorkflow to dead-letter the
    run rather than crash the workflow task into an infinite retry."""


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

    async def _notify_meta(self, run_id: str, tokens_used: int = 0) -> None:
        """Signal run_completed to the meta workflow so active_runs drains (TMP-5).

        Guard: only when this run was dispatched *by* the meta workflow — the
        parent workflow id is deterministic workflow state, so this needs no
        input flag and cannot misfire for CLI/API-started runs. Best-effort:
        a missing/closed meta singleton must not fail a finished run.
        ``tokens_used`` charges the run against the meta budget (TMP-17).
        """
        parent = workflow.info().parent
        if parent is None or parent.workflow_id != META_WORKFLOW_ID:
            return
        try:
            handle = workflow.get_external_workflow_handle(META_WORKFLOW_ID)
            await handle.signal("run_completed", args=[run_id, tokens_used])
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - best-effort notification
            workflow.logger.warning(
                "run_completed signal to %s failed: %s", META_WORKFLOW_ID, exc
            )

    @staticmethod
    def _spec_name_version(bundle: dict) -> tuple[str, int]:
        """Extract the agent name/version from the rendered bundle, raising a
        clear error on a malformed spec (TMP-20) so the run can be dead-lettered
        instead of KeyError-crashing the workflow task into an infinite retry."""
        try:
            meta = bundle["agent_spec"]["metadata"]
            return str(meta["name"]), int(meta["version"])
        except (KeyError, TypeError, ValueError) as exc:
            raise _MalformedSpec(str(exc)) from exc

    @workflow.run
    async def run(self, inp: AgentRunInput) -> AgentRunOutput:
        try:
            return await self._run_lifecycle(inp)
        except _MalformedSpec as err:
            # TMP-20: a malformed spec is a permanent, data-shaped failure —
            # retrying can never fix it. Record a terminal failed phase and
            # return a failed output (do NOT re-raise into an infinite retry).
            await self._fail_terminally(inp.run_id, f"malformed_spec: {err}")
            return AgentRunOutput(inp.run_id, "failed", "", "")
        except (ActivityError, ChildWorkflowError) as err:
            # TMP-10: retry exhaustion must not leave the ledger stuck at a
            # non-terminal phase forever — record a terminal failed phase (and
            # its finished event) best-effort, then let the workflow fail.
            cause = getattr(err, "cause", None) or err
            await self._fail_terminally(inp.run_id, str(cause))
            raise

    async def _fail_terminally(self, run_id: str, error: str) -> None:
        try:
            await self._advance(run_id, "failed", {"error": error})
        except (ActivityError, ChildWorkflowError) as persist_err:
            workflow.logger.warning(
                "could not persist terminal failed phase for %s: %s",
                run_id, persist_err,
            )
        await self._notify_meta(run_id)

    async def _run_lifecycle(self, inp: AgentRunInput) -> AgentRunOutput:
        workflow_id = workflow.info().workflow_id
        await workflow.execute_activity(
            create_run, args=[inp, workflow_id], **_SHORT
        )
        self._phase = "created"

        bundle = await workflow.execute_activity(render_bundle, inp, **_SHORT)
        # Validate the spec shape up front (TMP-20): a bundle whose agent spec
        # lacks a usable name/version raises _MalformedSpec here, which the run
        # wrapper dead-letters, instead of a bare KeyError deep in the flow.
        agent_name, agent_version = self._spec_name_version(bundle)
        await self._advance(inp.run_id, "bundle_rendered")

        if self._cancelled:
            await self._advance(inp.run_id, "cancelled")
            await self._notify_meta(inp.run_id)
            return AgentRunOutput(inp.run_id, "cancelled", "", "")

        # `sandbox_starting` and `agent_running` used to be two back-to-back
        # persist activities with no work between them (two ledger round-trips
        # for no observable state change). Persist the single meaningful
        # transition — the run is about to execute in the sandbox — as
        # `agent_running`; the launch is instantaneous from the ledger's view.
        await self._advance(inp.run_id, "agent_running")
        # Race the sandbox activity against the cancel signal (TMP-21): a
        # cancel that arrives while the (multi-hour) sandbox is in flight now
        # requests activity cancellation — abox tears the microVM down in its
        # finally — and records a terminal `cancelled` phase, instead of the
        # signal being observed only in the narrow pre-sandbox window.
        sandbox_task = asyncio.ensure_future(
            workflow.execute_activity(run_sandbox, bundle, **_SANDBOX)
        )
        await workflow.wait_condition(
            lambda: sandbox_task.done() or self._cancelled
        )
        if self._cancelled and not sandbox_task.done():
            sandbox_task.cancel()
            await self._advance(inp.run_id, "cancelled")
            await self._notify_meta(inp.run_id)
            return AgentRunOutput(inp.run_id, "cancelled", agent_name, "")
        sandbox = await sandbox_task

        await self._advance(inp.run_id, "collecting_artifacts")
        result = sandbox.get("result")
        if not sandbox.get("succeeded") or result is None:
            await self._advance(inp.run_id, "failed", {"result": result})
            await self._notify_meta(inp.run_id, sandbox.get("tokens_used", 0))
            return AgentRunOutput(
                inp.run_id, "failed",
                agent_name, sandbox.get("git_branch", ""),
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

        # Canary graduation check (design §3): the workflow stays deterministic
        # — it only invokes the activity; comparison and transitions happen
        # ledger-side. Best-effort: a failed graduation check must not fail a
        # run that already completed.
        try:
            await workflow.execute_activity(
                check_canary_graduation,
                agent_name,
                **_SHORT,
            )
        except (ActivityError, ChildWorkflowError) as exc:
            workflow.logger.warning(
                "canary graduation check failed for %s: %s", inp.run_id, exc
            )

        await self._notify_meta(inp.run_id, sandbox.get("tokens_used", 0))
        return AgentRunOutput(
            run_id=inp.run_id,
            phase="completed",
            agent_ref=f"{agent_name}@{agent_version}",
            git_branch=sandbox.get("git_branch", ""),
            result=result,
            scorecard=eval_out.get("scorecard"),
            eval_results=eval_out.get("eval_results", []),
            diff=sandbox.get("diff", ""),
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
        # When the meta-agent dispatched this loop, signal run_completed on
        # every exit so its active_runs slot drains (TMP-19) — symmetric with
        # AgentRunWorkflow._notify_meta.
        try:
            return await self._run(inp)
        finally:
            await self._notify_meta(inp)

    async def _notify_meta(self, inp: OptimizeInput) -> None:
        if inp.tracking_run_id is None:
            return
        parent = workflow.info().parent
        if parent is None or parent.workflow_id != META_WORKFLOW_ID:
            return
        try:
            handle = workflow.get_external_workflow_handle(META_WORKFLOW_ID)
            await handle.signal("run_completed", inp.tracking_run_id)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - best-effort notification
            workflow.logger.warning(
                "optimize run_completed signal to %s failed: %s",
                META_WORKFLOW_ID, exc,
            )

    async def _run(self, inp: OptimizeInput) -> dict:
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
            if scout_run_failed(scout):
                # One retry, then a distinct failure outcome — an infra/model
                # failure (including a blocked scout that delivered no
                # followups, issue #27) must never masquerade as "no-change"
                # (OPT-12).
                scout = await self._child_run(
                    scout_objective(inp.objective, feedback=feedback),
                    inp.scout_spec,
                    inp.timeout_seconds,
                )
                scout_result = scout.get("result") or {}
                if scout_run_failed(scout):
                    self._phase = "scout-failed"
                    return {
                        "status": "scout-failed",
                        "rounds_used": self._round,
                        "reason": "scout run failed: "
                        + str(scout_result.get("summary") or "no result collected"),
                    }
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
            # return_exceptions (TMP-11): one crashed attempt must not fail
            # the whole round or terminate its siblings — it becomes an
            # ineligible candidate whose crash feeds the next scout round.
            raw = await asyncio.gather(
                *(
                    self._child_run(
                        attempt_objective(inp.objective, approach=a, index=i),
                        inp.attempt_spec,
                        inp.timeout_seconds,
                    )
                    for i, a in enumerate(approaches)
                ),
                return_exceptions=True,
            )
            attempts: list[dict] = []
            for index, out in enumerate(raw):
                if isinstance(out, asyncio.CancelledError):
                    raise out
                if isinstance(out, BaseException):
                    workflow.logger.warning(
                        "optimize attempt %d crashed: %s", index + 1, out
                    )
                    attempts.append(
                        {
                            "run_id": None,
                            "phase": "failed",
                            "git_branch": "",
                            "result": {
                                "status": "failed",
                                "summary": f"attempt {index + 1} crashed: {out}",
                            },
                            "scorecard": None,
                        }
                    )
                else:
                    attempts.append(out)

            self._phase = "selecting"
            # Issue #28: a winner's self-reported bench claim must reproduce
            # in an independent fresh-sandbox measurement before it is
            # trusted; unreproduced candidates are rejected with feedback and
            # selection falls through to the next eligible attempt.
            bench_cmd = (inp.objective.get("constraints") or {}).get("benchCommand")
            remaining = list(attempts)
            verify_feedback: list[str] = []
            verified = False
            winner = select_winner(remaining)
            while winner is not None and bench_cmd:
                ok = False
                detail = ""
                skipped = False
                try:
                    timings = await workflow.execute_activity(
                        measure_winner_bench,
                        args=[
                            winner.get("diff") or "",
                            bench_cmd,
                            inp.objective.get("repo", ""),
                        ],
                        **_LONG,
                    )
                    if timings.get("skipped"):
                        skipped = True
                    else:
                        ok, detail = bench_reproduces(
                            timings["before"], timings["after"]
                        )
                except (ActivityError, ChildWorkflowError) as exc:
                    detail = f"bench verification errored: {exc}"
                if skipped:
                    break  # no measurer available: accept, marked unverified
                if ok:
                    verified = True
                    break
                title = ((winner.get("result") or {}).get("summary") or "attempt")
                verify_feedback.append(
                    f"'{title[:120]}': failed independent bench verification: "
                    f"{detail}"
                )
                remaining = [c for c in remaining if c is not winner]
                winner = select_winner(remaining)
            if winner is not None:
                self._phase = "improved"
                return {
                    "status": "improved",
                    "rounds_used": self._round,
                    "winner_run_id": winner.get("run_id"),
                    "git_branch": winner.get("git_branch"),
                    "scorecard": winner.get("scorecard"),
                    "result": winner.get("result"),
                    "bench_verified": verified,
                }
            # Accumulate across rounds (OPT-17), mirroring run_optimize_loop.
            feedback = feedback + round_feedback(list(attempts)) + verify_feedback

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
        "diff": out.diff,
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
    # Ids already dispatched/dead-lettered. Observer objective ids are
    # deterministic, so id-dedupe suffices to stop the same signal being
    # re-dispatched every observer cycle. Bounded FIFO, carried across
    # Continue-As-New.
    processed_ids: list[str] = field(default_factory=list)
    # History-roll threshold; part of the carried state so tests (and
    # operators) can lower it without patching module globals.
    continue_as_new_threshold: int = _CONTINUE_AS_NEW_THRESHOLD

    # --- governance that actually governs (TMP-17) ---
    # Global ceiling on concurrently dispatched runs. role_concurrency caps a
    # single role; a role with no explicit cap falls back to this global one.
    max_concurrent_runs: int = 4
    # Role of each active run, so per-role concurrency can be counted. Kept in
    # lockstep with active_runs (added on dispatch, dropped on completion).
    active_run_roles: dict[str, str] = field(default_factory=dict)
    # Deterministic dispatch time (workflow.now().isoformat()) of each active
    # run, so a leaked entry — an ABANDON'd child whose worker died and never
    # signalled run_completed — is reconciled out after active_run_ttl_hours
    # instead of blocking dispatch forever (TMP-18).
    active_run_started: dict[str, str] = field(default_factory=dict)
    active_run_ttl_hours: float = 3.0  # > the 2h sandbox start-to-close
    # Idle heartbeat: the run loop wakes at least this often even with no
    # dispatchable work, so stale-run reconciliation runs and a paused meta
    # under signal inflow still rolls history (bounds the CAN edge case).
    idle_wake_minutes: float = 30.0
    # Budget accounting: each completed run decrements budget_usd_remaining by
    # tokens_used/1000 * usd_per_1k_tokens. The rate defaults to 0.0 (budget is
    # a manual kill-switch only) so behaviour is unchanged until an operator
    # prices tokens via change_token_price; once priced, the budget is a hard
    # dispatch gate — no run starts while budget_usd_remaining <= 0.
    usd_per_1k_tokens: float = 0.0


@workflow.defn
class MetaAgentWorkflow:
    """The control-plane intelligence as a durable entity workflow."""

    def __init__(self) -> None:
        self._state = MetaState()
        self._backlog: list[dict[str, Any]] = []
        self._handled = 0
        self._paused = False

    # Retain at most this many processed objective ids for dedupe.
    _PROCESSED_IDS_MAX = 10_000

    def _is_duplicate(self, objective: dict[str, Any]) -> bool:
        obj_id = objective.get("id")
        if not obj_id:
            return False
        return obj_id in self._state.processed_ids or any(
            o.get("id") == obj_id for o in self._backlog
        )

    def _mark_processed(self, objective: dict[str, Any]) -> None:
        obj_id = objective.get("id")
        if obj_id:
            self._state.processed_ids.append(obj_id)
            overflow = len(self._state.processed_ids) - self._PROCESSED_IDS_MAX
            if overflow > 0:
                del self._state.processed_ids[:overflow]

    # --- Signals (async events, section 11.4) ---
    @workflow.signal
    def new_objective(self, objective: dict[str, Any]) -> None:
        if self._is_duplicate(objective):
            return
        self._backlog.append(objective)

    @workflow.signal
    def run_completed(self, run_id: str, tokens_used: int = 0) -> None:
        self._drop_active_run(run_id)
        self._state.processed_objectives += 1
        # Charge the run against the budget (TMP-17). With the default 0.0 rate
        # this is a no-op; once tokens are priced it decrements the ceiling
        # that gates dispatch.
        if tokens_used and self._state.usd_per_1k_tokens:
            self._state.budget_usd_remaining -= (
                tokens_used / 1000.0 * self._state.usd_per_1k_tokens
            )

    def _drop_active_run(self, run_id: str) -> None:
        if run_id in self._state.active_runs:
            self._state.active_runs.remove(run_id)
        self._state.active_run_roles.pop(run_id, None)
        self._state.active_run_started.pop(run_id, None)

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

    @workflow.query
    def get_budget_state(self) -> dict[str, Any]:
        """Real budget/concurrency state (spec §11.4 get_budget_state)."""
        role_active: dict[str, int] = {}
        for role in self._state.active_run_roles.values():
            role_active[role] = role_active.get(role, 0) + 1
        return {
            "budget_usd_remaining": self._state.budget_usd_remaining,
            "usd_per_1k_tokens": self._state.usd_per_1k_tokens,
            "budget_exhausted": self._budget_exhausted(),
            "active_runs": len(self._state.active_runs),
            "max_concurrent_runs": self._state.max_concurrent_runs,
            "role_concurrency": dict(self._state.role_concurrency),
            "role_active": role_active,
        }

    # --- Updates (validated state changes returning a result, section 11.4) ---
    @workflow.update
    def submit_objective(self, objective: dict[str, Any]) -> str:
        if not self._is_duplicate(objective):
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

    @workflow.update
    def change_max_concurrent_runs(self, limit: int) -> int:
        self._state.max_concurrent_runs = limit
        return limit

    @workflow.update
    def change_token_price(self, usd_per_1k_tokens: float) -> float:
        """Price tokens so the USD budget becomes a real dispatch gate (TMP-17)."""
        self._state.usd_per_1k_tokens = usd_per_1k_tokens
        return usd_per_1k_tokens

    # --- dispatch gating (TMP-17) ---
    def _budget_exhausted(self) -> bool:
        return self._state.budget_usd_remaining <= 0

    @staticmethod
    def _role_of(objective: dict[str, Any]) -> str:
        return resolve_agent_name(objective) or objective.get("type") or "default"

    def _role_cap(self, role: str) -> int:
        # A role with no explicit cap is limited only by the global ceiling.
        return self._state.role_concurrency.get(role, self._state.max_concurrent_runs)

    def _role_active_count(self, role: str) -> int:
        return sum(1 for r in self._state.active_run_roles.values() if r == role)

    def _dispatch_candidate(self) -> dict[str, Any] | None:
        """The next backlog objective that may dispatch *now*, or None.

        Enforces the governance knobs that used to be decorative (TMP-17): the
        mode/pause gate, the USD budget ceiling, the global concurrency cap,
        and per-role concurrency. Scans the backlog in order and returns the
        first objective whose role still has capacity, so a single capped role
        does not head-of-line-block unrelated work while global capacity
        remains.
        """
        if self._paused or self._state.mode in ("observe", "propose"):
            return None
        if self._budget_exhausted():
            return None
        if len(self._state.active_runs) >= self._state.max_concurrent_runs:
            return None
        for objective in self._backlog:
            role = self._role_of(objective)
            if self._role_active_count(role) < self._role_cap(role):
                return objective
        return None

    def _stale_active_runs(self, now: datetime) -> list[str]:
        """Active-run ids older than the TTL (pure; unit-testable off a
        workflow). ``now`` is the deterministic ``workflow.now()``."""
        ttl = timedelta(hours=self._state.active_run_ttl_hours)
        return [
            run_id
            for run_id, ts in self._state.active_run_started.items()
            if now - datetime.fromisoformat(ts) > ttl
        ]

    def _reconcile_active_runs(self, now: datetime) -> None:
        """Drop leaked active-run entries older than the TTL (TMP-18).

        AgentRunWorkflow signals run_completed on every terminal path, but an
        ABANDON'd child whose worker died can never signal; without this its
        run_id would occupy a concurrency slot forever (durably, across CAN).
        """
        for run_id in self._stale_active_runs(now):
            workflow.logger.warning(
                "reconciling leaked active run %s (no completion after %sh)",
                run_id, self._state.active_run_ttl_hours,
            )
            self._drop_active_run(run_id)

    @workflow.run
    async def run(self, carried: MetaState | None = None) -> None:
        if carried is not None:
            self._state = carried
            # Restore any backlog carried across the Continue-As-New boundary.
            self._backlog = list(carried.pending_backlog)
            self._state.pending_backlog = []

        while True:
            self._reconcile_active_runs(workflow.now())
            # Wake when there is dispatchable work or it is time to roll
            # history; otherwise wake on the idle heartbeat so stale-run
            # reconciliation still runs (and a paused meta under inflow still
            # rolls history). Backlog is never dropped while paused/observing.
            try:
                await workflow.wait_condition(
                    lambda: self._dispatch_candidate() is not None
                    or self._handled >= self._state.continue_as_new_threshold,
                    timeout=timedelta(minutes=self._state.idle_wake_minutes),
                )
            except TimeoutError:
                # Idle heartbeat: count it toward the CAN threshold so even a
                # persistently paused/blocked meta eventually rolls history,
                # then re-loop to reconcile.
                self._handled += 1
                continue

            if self._handled >= self._state.continue_as_new_threshold:
                # Carry the full state, including any undispatched backlog.
                self._state.pending_backlog = list(self._backlog)
                workflow.continue_as_new(self._state)

            objective = self._dispatch_candidate()
            if objective is None:
                continue  # nothing dispatchable right now; re-evaluate
            self._backlog.remove(objective)
            self._handled += 1
            self._mark_processed(objective)

            # The run id is minted before spec resolution so canary routing is
            # deterministic per run (design §2).
            run_id = objective.get("run_id") or workflow.uuid4().hex
            role = self._role_of(objective)

            # Resolve the agent spec (TMP-3): an inline agent_spec wins, then
            # suggestedAgents[0] / the per-type default, loaded via activity
            # (which enforces active-only resolution + canary routing, OPT-5).
            # Unresolvable objectives are dead-lettered, never crash the task.
            spec = objective.get("agent_spec")
            if not isinstance(spec, dict):
                spec = None
                agent_name = resolve_agent_name(objective)
                if agent_name is not None:
                    spec = await workflow.execute_activity(
                        load_agent_spec, args=[agent_name, run_id], **_SHORT
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

            self._track_active_run(run_id, role)

            # An `optimize` objective drives the scout->attempt->verify loop
            # (TMP-19): dispatching it as a plain AgentRunWorkflow would run a
            # single scout and never fan out. OptimizationWorkflow notifies
            # run_completed itself so active_runs still drains.
            if objective.get("type") == "optimize":
                await self._dispatch_optimize(run_id, objective, spec)
                continue

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

    def _track_active_run(self, run_id: str, role: str) -> None:
        self._state.active_runs.append(run_id)
        self._state.active_run_roles[run_id] = role
        self._state.active_run_started[run_id] = workflow.now().isoformat()

    async def _dispatch_optimize(
        self, run_id: str, objective: dict[str, Any], scout_spec: dict[str, Any]
    ) -> None:
        """Route an optimize objective into OptimizationWorkflow (TMP-19).

        The scout spec is the one already resolved for the objective; the
        attempt spec is loaded the same active-only way. If the attempt spec
        can't be resolved the objective is dead-lettered (and its active-run
        slot released) rather than starting a loop that can never attempt.
        """
        attempt_spec = await workflow.execute_activity(
            load_agent_spec, args=["optimize-attempt", run_id], **_SHORT
        )
        if not isinstance(attempt_spec, dict):
            self._drop_active_run(run_id)
            reason = "no optimize-attempt spec resolvable for optimize objective"
            workflow.logger.warning(
                "dead-lettering optimize objective %s: %s",
                objective.get("id"), reason,
            )
            self._state.dead_letter.append({"objective": objective, "reason": reason})
            return
        await workflow.start_child_workflow(
            OptimizationWorkflow.run,
            OptimizeInput(
                objective=objective,
                scout_spec=scout_spec,
                attempt_spec=attempt_spec,
                tracking_run_id=run_id,
            ),
            id=f"optimize-{run_id}",
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

        # Poll on an interval, then Continue-As-New. Each execution does exactly
        # one collect+sleep+CAN, so its own history stays tiny — no rollover
        # counter is needed to bound it.
        await workflow.sleep(timedelta(minutes=15))
        workflow.continue_as_new(ObserveInput(repo=inp.repo))
