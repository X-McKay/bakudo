"""The Temporal workflows under a real (time-skipping) test environment.

These are the tests that would have caught the Phase-1 class of bug: a
meta-agent that crashes on dispatch, a run that never signals completion,
workflows that were never registered. They drive real workflow code through
a real worker; only the sandbox is scripted (FauxDriver) and the ledger is
in-memory.

The time-skipping test server is downloaded by the SDK on first use; when
that is impossible (offline sandbox), the module skips rather than fails.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import uuid

import pytest

pytest.importorskip("temporalio")

from temporalio.testing import WorkflowEnvironment  # noqa: E402
from temporalio.worker import Worker  # noqa: E402

from bakudo.agent_spec import load_spec_file  # noqa: E402
from bakudo.paths import agents_dir  # noqa: E402
from bakudo.registry import InMemoryLedger  # noqa: E402
from bakudo.temporal import _impl  # noqa: E402
from bakudo.temporal.activities import ALL_ACTIVITIES  # noqa: E402
from bakudo.temporal.client import META_WORKFLOW_ID  # noqa: E402
from bakudo.temporal.shared import (  # noqa: E402
    AgentRunInput,
    OptimizeInput,
)
from bakudo.temporal.workflows import (  # noqa: E402
    AgentEvolutionWorkflow,
    AgentRunWorkflow,
    EvalWorkflow,
    MemoryCompactionWorkflow,
    MetaAgentWorkflow,
    OptimizationWorkflow,
    RepoObserverWorkflow,
)
from bakudo.testing import FauxDriver, FauxRun  # noqa: E402

TASK_QUEUE = "bakudo-test"

ALL_WORKFLOWS = [
    MetaAgentWorkflow,
    AgentRunWorkflow,
    EvalWorkflow,
    OptimizationWorkflow,
    AgentEvolutionWorkflow,
    MemoryCompactionWorkflow,
    RepoObserverWorkflow,
]


@pytest.fixture
async def env():
    try:
        environment = await WorkflowEnvironment.start_time_skipping()
    except Exception as exc:  # noqa: BLE001 - typically: cannot download test server
        pytest.skip(f"Temporal test server unavailable: {exc}")
    yield environment
    await environment.shutdown()


@pytest.fixture
def deps(monkeypatch):
    """Fresh in-memory ledger + a slot for the scripted sandbox."""
    ledger = InMemoryLedger()
    monkeypatch.setattr(_impl.DEPS, "ledger", ledger)
    return ledger


def _worker(env) -> Worker:
    return Worker(
        env.client,
        task_queue=TASK_QUEUE,
        workflows=ALL_WORKFLOWS,
        activities=ALL_ACTIVITIES,
        activity_executor=concurrent.futures.ThreadPoolExecutor(max_workers=4),
    )


def _explore_objective(**overrides) -> dict:
    doc = {
        "id": "obj_01HZZZZZZZZZZZZZZZZZZZZZZ7",
        "type": "explore",
        "repo": "bakudo",
        "title": "temporal test objective",
    }
    doc.update(overrides)
    return doc


async def test_agent_run_workflow_full_lifecycle(env, deps, monkeypatch):
    monkeypatch.setattr(
        _impl.DEPS,
        "sandbox",
        FauxDriver([FauxRun(changed_files=["src/a.py"], tests=[("pytest -q", "passed")])]),
    )
    spec = load_spec_file(agents_dir() / "explore.yaml").to_dict()

    async with _worker(env):
        out = await env.client.execute_workflow(
            AgentRunWorkflow.run,
            AgentRunInput(
                run_id="run_temporal_1",
                objective=_explore_objective(),
                agent_spec=spec,
            ),
            id=f"run-{uuid.uuid4()}",
            task_queue=TASK_QUEUE,
        )

    assert out.phase == "completed"
    assert out.scorecard is not None
    assert "sandbox" in out.scorecard["passed_suites"]
    record = deps.get_run("run_temporal_1")
    assert record is not None and record.phase.value == "completed"


async def test_meta_agent_dispatches_and_drains(env, deps, monkeypatch):
    """The Phase-1 bugs, as a regression test: an objective WITHOUT an inline
    agent_spec must dispatch (spec resolved from the seed set), and the child
    run's completion signal must drain active_runs."""
    monkeypatch.setattr(_impl.DEPS, "sandbox", FauxDriver([FauxRun()]))

    async with _worker(env):
        handle = await env.client.start_workflow(
            MetaAgentWorkflow.run,
            id=META_WORKFLOW_ID,
            task_queue=TASK_QUEUE,
        )
        await handle.execute_update(
            MetaAgentWorkflow.submit_objective, _explore_objective()
        )

        async def drained() -> dict:
            while True:
                status = await handle.query(MetaAgentWorkflow.get_status)
                if status["processed_objectives"] >= 1 and not status["active_runs"]:
                    return status
                await asyncio.sleep(0.2)

        status = await asyncio.wait_for(drained(), timeout=60)
        assert status["processed_objectives"] == 1
        assert status["unassignable"] == []
        await handle.terminate()


async def test_meta_agent_dead_letters_unresolvable_objective(env, deps):
    async with _worker(env):
        handle = await env.client.start_workflow(
            MetaAgentWorkflow.run,
            id=META_WORKFLOW_ID,
            task_queue=TASK_QUEUE,
        )
        await handle.execute_update(
            MetaAgentWorkflow.submit_objective,
            _explore_objective(
                id="obj_01HZZZZZZZZZZZZZZZZZZZZZX1",
                suggestedAgents=["no-such-agent"],
            ),
        )

        async def dead_lettered() -> dict:
            while True:
                status = await handle.query(MetaAgentWorkflow.get_status)
                if status["unassignable"]:
                    return status
                await asyncio.sleep(0.2)

        status = await asyncio.wait_for(dead_lettered(), timeout=60)
        assert status["unassignable"] == ["obj_01HZZZZZZZZZZZZZZZZZZZZZX1"]
        assert status["active_runs"] == []
        await handle.terminate()


async def test_optimization_workflow_no_change_when_scout_finds_nothing(
    env, deps, monkeypatch
):
    monkeypatch.setattr(
        _impl.DEPS,
        "sandbox",
        FauxDriver([FauxRun(proposed_followups=[])]),
    )
    scout = load_spec_file(agents_dir() / "optimize-scout.yaml").to_dict()
    attempt = load_spec_file(agents_dir() / "optimize-attempt.yaml").to_dict()

    async with _worker(env):
        out = await env.client.execute_workflow(
            OptimizationWorkflow.run,
            OptimizeInput(
                objective=_explore_objective(type="optimize"),
                scout_spec=scout,
                attempt_spec=attempt,
                max_rounds=1,
            ),
            id=f"optimize-{uuid.uuid4()}",
            task_queue=TASK_QUEUE,
        )

    assert out["status"] == "no-change"
    assert out["reason"] == "scout proposed no approaches"


async def test_eval_workflow_grades_schema_invalid_result(env, deps):
    from bakudo.temporal.shared import EvalInput

    async with _worker(env):
        out = await env.client.execute_workflow(
            EvalWorkflow.run,
            EvalInput(
                run_id="run_temporal_eval",
                objective=_explore_objective(),
                result={"status": "success"},  # schema-invalid
            ),
            id=f"eval-{uuid.uuid4()}",
            task_queue=TASK_QUEUE,
        )
    suites = {r["suite_name"]: r for r in out["eval_results"]}
    assert suites["schema"]["passed"] is False
