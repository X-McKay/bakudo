"""TMP-1/TMP-4: worker registration and activity-executor configuration.

The activities call blocking code (subprocess sandbox runs, sync psycopg,
httpx), so they must be plain ``def`` functions run on a thread-pool
``activity_executor`` — an async activity would freeze the shared event loop
for both task queues.
"""

from __future__ import annotations

import inspect
from concurrent.futures import ThreadPoolExecutor

from bakudo.temporal.activities import ALL_ACTIVITIES
from bakudo.temporal.shared import TASK_QUEUE_CONTROL, TASK_QUEUE_RUNS


def test_all_activities_are_sync():
    """Async activities on a shared event loop block both task queues (TMP-1)."""
    offenders = [fn.__name__ for fn in ALL_ACTIVITIES if inspect.iscoroutinefunction(fn)]
    assert offenders == [], f"activities must be sync def: {offenders}"


def test_control_queue_registers_every_control_plane_workflow():
    """TMP-4: unregistered workflow types hang with 'workflow type not
    registered' — evolution/compaction/observer must be on the control queue."""
    from bakudo.temporal.worker import worker_configs
    from bakudo.temporal.workflows import (
        AgentEvolutionWorkflow,
        AgentRunWorkflow,
        EvalWorkflow,
        MemoryCompactionWorkflow,
        MetaAgentWorkflow,
        OptimizationWorkflow,
        RepoObserverWorkflow,
    )

    configs = {cfg["task_queue"]: cfg for cfg in worker_configs()}
    control = configs[TASK_QUEUE_CONTROL]["workflows"]
    for wf in (
        MetaAgentWorkflow,
        AgentRunWorkflow,
        EvalWorkflow,
        OptimizationWorkflow,
        AgentEvolutionWorkflow,
        MemoryCompactionWorkflow,
        RepoObserverWorkflow,
    ):
        assert wf in control, f"{wf.__name__} missing from the control queue"

    runs = configs[TASK_QUEUE_RUNS]["workflows"]
    for wf in (AgentRunWorkflow, EvalWorkflow, OptimizationWorkflow):
        assert wf in runs, f"{wf.__name__} missing from the runs queue"


def test_run_sandbox_activity_options_pin_heartbeat_and_single_attempt():
    """TMP-12: run_sandbox must carry a heartbeat_timeout (crash detection in
    minutes, not 2h) and maximum_attempts=1 — a retried sandbox on the same
    run_id/branch is not idempotent."""
    from datetime import timedelta

    from bakudo.temporal.workflows import _SANDBOX

    assert _SANDBOX["retry_policy"].maximum_attempts == 1
    assert _SANDBOX["heartbeat_timeout"] is not None
    assert _SANDBOX["heartbeat_timeout"] <= timedelta(minutes=10)
    assert _SANDBOX["start_to_close_timeout"] == timedelta(hours=2)


def test_worker_configs_use_thread_pool_executor():
    from bakudo.temporal.worker import worker_configs

    configs = {cfg["task_queue"]: cfg for cfg in worker_configs()}
    assert set(configs) == {TASK_QUEUE_CONTROL, TASK_QUEUE_RUNS}
    for cfg in configs.values():
        assert isinstance(cfg["activity_executor"], ThreadPoolExecutor)
        assert list(cfg["activities"]) == list(ALL_ACTIVITIES)
