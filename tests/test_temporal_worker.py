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


def test_worker_configs_use_thread_pool_executor():
    from bakudo.temporal.worker import worker_configs

    configs = {cfg["task_queue"]: cfg for cfg in worker_configs()}
    assert set(configs) == {TASK_QUEUE_CONTROL, TASK_QUEUE_RUNS}
    for cfg in configs.values():
        assert isinstance(cfg["activity_executor"], ThreadPoolExecutor)
        assert list(cfg["activities"]) == list(ALL_ACTIVITIES)
