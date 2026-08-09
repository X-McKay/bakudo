"""Workflow tests against the Temporal time-skipping test environment.

These are the first real workflow tests in the codebase (the TMP-* findings
shipped precisely because none existed). They run workflows on an in-process
Worker wired to the same thread-pool activity executor production uses, with
the sandbox stubbed and the InMemoryLedger injected — no live services.
"""

from __future__ import annotations

import asyncio
import time
from concurrent.futures import ThreadPoolExecutor

import pytest
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

from bakudo.abox.runner import AboxOutcome
from bakudo.registry import InMemoryLedger
from bakudo.temporal import _impl
from bakudo.temporal.activities import ALL_ACTIVITIES
from bakudo.temporal.client import META_WORKFLOW_ID
from bakudo.temporal.shared import TASK_QUEUE_CONTROL, resolve_agent_name
from bakudo.temporal.workflows import (
    AgentRunWorkflow,
    EvalWorkflow,
    MetaAgentWorkflow,
    MetaState,
    OptimizationWorkflow,
)

# --- deterministic agent-name resolution (TMP-3) ---


def test_resolve_agent_name_prefers_suggested_agents():
    objective = {"id": "o", "type": "explore", "suggestedAgents": ["qa", "explore"]}
    assert resolve_agent_name(objective) == "qa"


def test_resolve_agent_name_falls_back_to_type_default():
    assert resolve_agent_name({"id": "o", "type": "explore"}) == "explore"
    assert resolve_agent_name({"id": "o", "type": "optimize"}) == "optimize-scout"


def test_resolve_agent_name_unresolvable_returns_none():
    assert resolve_agent_name({"id": "o", "type": "skill-gen"}) is None
    assert resolve_agent_name({"id": "o"}) is None


# --- WorkflowEnvironment scaffolding ---


def stub_sandbox(bundle):
    """A successful sandbox outcome with a schema-valid result."""
    return AboxOutcome(
        run_id=bundle.run_id,
        abox_task_id=bundle.run_id,
        exit_code=0,
        git_branch=f"agent/{bundle.run_id}",
        result={
            "run_id": bundle.run_id,
            "agent": "explore@1",
            "objective_id": bundle.objective_id,
            "status": "success",
            "summary": "stubbed sandbox run",
        },
    )


@pytest.fixture
def deps(monkeypatch):
    ledger = InMemoryLedger()
    monkeypatch.setattr(_impl.DEPS, "ledger", ledger)
    monkeypatch.setattr(_impl.DEPS, "sandbox", stub_sandbox)
    return ledger


@pytest.fixture
async def env():
    environment = await WorkflowEnvironment.start_time_skipping()
    yield environment
    await environment.shutdown()


def make_worker(env, workflows):
    return Worker(
        env.client,
        task_queue=TASK_QUEUE_CONTROL,
        workflows=workflows,
        activities=ALL_ACTIVITIES,
        activity_executor=ThreadPoolExecutor(max_workers=8, thread_name_prefix="test-act"),
    )


async def _poll(predicate, timeout=15.0, interval=0.1):
    """Await a condition fed by real-time activity completions."""
    deadline = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < deadline:
        if await predicate():
            return True
        await asyncio.sleep(interval)
    return False


# --- singleton startup (TMP-7) ---


async def test_ensure_meta_agent_double_call_is_a_noop(env):
    """The second ensure must attach to the running singleton, not raise
    WorkflowAlreadyStartedError."""
    from temporalio.client import WorkflowExecutionStatus

    from bakudo.temporal.client import ensure_meta_agent

    first = await ensure_meta_agent(env.client)
    second = await ensure_meta_agent(env.client)
    assert first.id == second.id == META_WORKFLOW_ID

    desc = await env.client.get_workflow_handle(META_WORKFLOW_ID).describe()
    assert desc.status == WorkflowExecutionStatus.RUNNING


# --- meta-agent dispatch (TMP-3) ---


async def test_meta_dispatches_observer_objective_without_agent_spec(env, deps):
    """Observer objectives carry suggestedAgents, never agent_spec — dispatch
    must resolve the spec instead of KeyError-wedging the singleton."""
    async with make_worker(env, [MetaAgentWorkflow, AgentRunWorkflow, EvalWorkflow]):
        handle = await env.client.start_workflow(
            MetaAgentWorkflow.run, id=META_WORKFLOW_ID, task_queue=TASK_QUEUE_CONTROL
        )
        await handle.signal(
            MetaAgentWorkflow.new_objective,
            {
                "id": "obj_OBS1",
                "type": "explore",
                "repo": "bakudo",
                "title": "observer objective",
                "suggestedAgents": ["explore"],
            },
        )

        async def dispatched():
            return bool(deps._runs)

        assert await _poll(dispatched), "no run was created from the observer objective"
        run = next(iter(deps._runs.values()))
        assert run.agent_ref.startswith("explore@")
        status = await handle.query(MetaAgentWorkflow.get_status)
        assert status["backlog"] == 0


async def test_meta_dead_letters_unresolvable_objective(env, deps):
    """An unresolvable objective must not crash the workflow task — it goes to
    a dead-letter list with a warning and the loop keeps going."""
    async with make_worker(env, [MetaAgentWorkflow, AgentRunWorkflow, EvalWorkflow]):
        handle = await env.client.start_workflow(
            MetaAgentWorkflow.run, id=META_WORKFLOW_ID, task_queue=TASK_QUEUE_CONTROL
        )
        # No suggestedAgents and no default mapping for this type.
        await handle.signal(
            MetaAgentWorkflow.new_objective,
            {"id": "obj_DL1", "type": "skill-gen", "repo": "r", "title": "t"},
        )
        # suggestedAgents naming an agent that resolves to no spec document.
        await handle.signal(
            MetaAgentWorkflow.new_objective,
            {
                "id": "obj_DL2",
                "type": "explore",
                "repo": "r",
                "title": "t",
                "suggestedAgents": ["no-such-agent"],
            },
        )

        async def dead_lettered():
            dl = await handle.query(MetaAgentWorkflow.get_dead_letter)
            return len(dl) == 2

        assert await _poll(dead_lettered), "objectives were not dead-lettered"
        dl = await handle.query(MetaAgentWorkflow.get_dead_letter)
        assert {d["objective"]["id"] for d in dl} == {"obj_DL1", "obj_DL2"}
        assert all(d["reason"] for d in dl)
        # The workflow is still healthy: it can keep dispatching.
        status = await handle.query(MetaAgentWorkflow.get_status)
        assert status["backlog"] == 0
        assert deps._runs == {}


# --- backlog dedupe by objective id (observer ids are deterministic) ---


async def test_meta_dedupes_objectives_by_id(env, deps):
    """The same objective id signalled repeatedly — in the same cycle or a
    later observer cycle — must be dispatched at most once."""
    objective = {
        "id": "obj_DUP1",
        "type": "explore",
        "repo": "bakudo",
        "title": "dedupe test",
        "suggestedAgents": ["explore"],
    }
    async with make_worker(env, [MetaAgentWorkflow, AgentRunWorkflow, EvalWorkflow]):
        handle = await env.client.start_workflow(
            MetaAgentWorkflow.run, id=META_WORKFLOW_ID, task_queue=TASK_QUEUE_CONTROL
        )
        # Hold dispatch so in-backlog dedupe is observable.
        await handle.signal(MetaAgentWorkflow.pause_autonomy)
        await handle.signal(MetaAgentWorkflow.new_objective, objective)
        await handle.signal(MetaAgentWorkflow.new_objective, objective)
        backlog = await handle.query(MetaAgentWorkflow.get_backlog)
        assert [o["id"] for o in backlog] == ["obj_DUP1"], "backlog must dedupe by id"

        await handle.signal(MetaAgentWorkflow.resume_autonomy)

        async def processed():
            status = await handle.query(MetaAgentWorkflow.get_status)
            return status["processed_objectives"] == 1

        assert await _poll(processed)

        # A later cycle re-emitting the same id must be a no-op.
        await handle.signal(MetaAgentWorkflow.new_objective, objective)
        await asyncio.sleep(0.5)
        status = await handle.query(MetaAgentWorkflow.get_status)
        assert status["backlog"] == 0
        assert len(deps._runs) == 1, "the duplicate id was dispatched again"


# --- run-completion loop (TMP-5) ---


async def test_completed_child_run_drains_meta_active_runs(env, deps):
    """AgentRunWorkflow signals run_completed back to the meta workflow, so
    active_runs drains instead of growing forever across Continue-As-New."""
    async with make_worker(env, [MetaAgentWorkflow, AgentRunWorkflow, EvalWorkflow]):
        handle = await env.client.start_workflow(
            MetaAgentWorkflow.run, id=META_WORKFLOW_ID, task_queue=TASK_QUEUE_CONTROL
        )
        await handle.signal(
            MetaAgentWorkflow.new_objective,
            {
                "id": "obj_DRAIN1",
                "type": "explore",
                "repo": "bakudo",
                "title": "drain test",
                "suggestedAgents": ["explore"],
            },
        )

        async def drained():
            status = await handle.query(MetaAgentWorkflow.get_status)
            return status["active_runs"] == [] and status["processed_objectives"] == 1

        assert await _poll(drained), "active_runs never drained after child completion"
        # And the child really ran to completion through the ledger.
        run = next(iter(deps._runs.values()))
        assert run.phase.value == "completed"


# --- retry exhaustion leaves a terminal ledger record (TMP-10) ---


async def test_activity_exhaustion_writes_terminal_failed_phase(env, deps, monkeypatch):
    """When the sandbox activity exhausts its retries the workflow fails, but
    the ledger must not be left at agent_running forever: a terminal failed
    phase + finished event land first."""
    from temporalio.client import WorkflowFailureError

    def broken_sandbox(bundle):
        raise RuntimeError("sandbox exploded")

    monkeypatch.setattr(_impl.DEPS, "sandbox", broken_sandbox)
    spec = _impl.load_agent_spec("explore")
    assert spec is not None

    from bakudo.temporal.shared import AgentRunInput

    async with make_worker(env, [AgentRunWorkflow, EvalWorkflow]):
        with pytest.raises(WorkflowFailureError):
            await env.client.execute_workflow(
                AgentRunWorkflow.run,
                AgentRunInput(
                    run_id="run_FAIL1",
                    objective={"id": "obj_FAIL1", "type": "explore", "repo": "r",
                               "title": "t"},
                    agent_spec=spec,
                ),
                id="run-run_FAIL1",
                task_queue=TASK_QUEUE_CONTROL,
            )

        run = deps.get_run("run_FAIL1")
        assert run is not None
        assert run.phase.value == "failed", f"ledger stuck at {run.phase.value!r}"
        kinds = [e.event_type for e in deps.events("run_FAIL1")]
        assert kinds.count("finished") == 1


# --- one crashed optimize attempt must not fail the round (TMP-11) ---


async def test_crashed_optimize_attempt_becomes_feedback_not_failure(env, deps, monkeypatch):
    from bakudo.temporal.shared import OptimizeInput

    def scripted_sandbox(bundle):
        title = bundle.objective.title
        if "[optimize-scout]" in title:
            out = stub_sandbox(bundle)
            out.result["proposed_followups"] = ["approach A", "approach B"]
            return out
        if "[optimize-attempt 1]" in title:
            raise RuntimeError("attempt sandbox crashed")
        return stub_sandbox(bundle)

    monkeypatch.setattr(_impl.DEPS, "sandbox", scripted_sandbox)
    scout_spec = _impl.load_agent_spec("optimize-scout")
    attempt_spec = _impl.load_agent_spec("optimize-attempt")
    assert scout_spec and attempt_spec

    async with make_worker(
        env, [OptimizationWorkflow, AgentRunWorkflow, EvalWorkflow]
    ):
        out = await env.client.execute_workflow(
            OptimizationWorkflow.run,
            OptimizeInput(
                objective={
                    "id": "obj_OPT1", "type": "optimize", "repo": "bakudo",
                    "title": "opt", "constraints": {},
                },
                scout_spec=scout_spec,
                attempt_spec=attempt_spec,
                max_rounds=1,
                max_approaches=2,
            ),
            id="optimize-obj_OPT1",
            task_queue=TASK_QUEUE_CONTROL,
        )

    # The workflow completes (no-change), the crash surfacing as feedback.
    assert out["status"] == "no-change"
    assert out["rounds_used"] == 1
    assert any("crash" in fb for fb in out.get("feedback", [])), out.get("feedback")


# --- Continue-As-New must not kill in-flight runs (TMP-6) ---


async def test_continue_as_new_abandons_in_flight_children(env, deps, monkeypatch):
    """Children are started with ParentClosePolicy.ABANDON, so the meta
    workflow rolling its history does not terminate a sandbox mid-run."""
    from temporalio.client import WorkflowExecutionStatus

    def slow_sandbox(bundle):
        time.sleep(1.5)
        return stub_sandbox(bundle)

    monkeypatch.setattr(_impl.DEPS, "sandbox", slow_sandbox)

    async with make_worker(env, [MetaAgentWorkflow, AgentRunWorkflow, EvalWorkflow]):
        handle = await env.client.start_workflow(
            MetaAgentWorkflow.run,
            MetaState(continue_as_new_threshold=1),
            id=META_WORKFLOW_ID,
            task_queue=TASK_QUEUE_CONTROL,
        )
        first_run_id = (await handle.describe()).run_id
        await handle.signal(
            MetaAgentWorkflow.new_objective,
            {
                "id": "obj_CAN1",
                "type": "explore",
                "repo": "bakudo",
                "title": "in-flight during continue-as-new",
                "suggestedAgents": ["explore"],
            },
        )

        # Wait until the first meta run has rolled over via Continue-As-New.
        pinned = env.client.get_workflow_handle(META_WORKFLOW_ID, run_id=first_run_id)

        async def rolled_over():
            desc = await pinned.describe()
            return desc.status == WorkflowExecutionStatus.CONTINUED_AS_NEW

        assert await _poll(rolled_over), "meta workflow never continued-as-new"

        # The dispatched child must have survived the parent's rollover.
        status = await handle.query(MetaAgentWorkflow.get_status)
        assert len(status["active_runs"]) == 1
        child = env.client.get_workflow_handle(f"run-{status['active_runs'][0]}")
        desc = await child.describe()
        assert desc.status in (
            WorkflowExecutionStatus.RUNNING,
            WorkflowExecutionStatus.COMPLETED,
        ), f"child was {desc.status.name} — killed by parent close policy"

        # The test server is lenient about parent-close semantics, so also pin
        # the policy the child was actually started with at the history level.
        from temporalio.api.enums.v1 import ParentClosePolicy as ProtoPolicy

        history = await pinned.fetch_history()
        initiated = [
            e.start_child_workflow_execution_initiated_event_attributes
            for e in history.events
            if e.HasField("start_child_workflow_execution_initiated_event_attributes")
        ]
        assert initiated, "no child workflow was initiated by the meta run"
        assert all(
            attrs.parent_close_policy == ProtoPolicy.PARENT_CLOSE_POLICY_ABANDON
            for attrs in initiated
        ), "children must be started with ParentClosePolicy.ABANDON (TMP-6)"
