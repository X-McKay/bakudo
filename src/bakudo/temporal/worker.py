"""The Temporal worker process entrypoint (``bakudo-worker``).

Connects to Temporal, optionally wires the durable Postgres ledger + Neo4j
graph into the activity layer, and serves the control and run task queues.
"""

from __future__ import annotations

import asyncio
import os


async def _run() -> None:
    from temporalio.client import Client
    from temporalio.worker import Worker

    from . import _impl
    from .activities import ALL_ACTIVITIES
    from .shared import TASK_QUEUE_CONTROL, TASK_QUEUE_RUNS
    from .workflows import AgentRunWorkflow, EvalWorkflow, MetaAgentWorkflow

    # Wire the durable ledger if a DSN is configured (otherwise in-memory).
    dsn = os.environ.get("BAKUDO_POSTGRES_DSN")
    if dsn:
        from ..registry.postgres_ledger import PostgresLedger

        _impl.configure(ledger=await PostgresLedger.connect(dsn))

    address = os.environ.get("TEMPORAL_ADDRESS", "localhost:7233")
    namespace = os.environ.get("TEMPORAL_NAMESPACE", "default")
    client = await Client.connect(address, namespace=namespace)

    workflows = [MetaAgentWorkflow, AgentRunWorkflow, EvalWorkflow]

    control = Worker(
        client,
        task_queue=TASK_QUEUE_CONTROL,
        workflows=workflows,
        activities=ALL_ACTIVITIES,
    )
    runs = Worker(
        client,
        task_queue=TASK_QUEUE_RUNS,
        workflows=[AgentRunWorkflow, EvalWorkflow],
        activities=ALL_ACTIVITIES,
    )
    print(f"[bakudo-worker] serving {TASK_QUEUE_CONTROL} + {TASK_QUEUE_RUNS} at {address}")
    await asyncio.gather(control.run(), runs.run())


def main() -> None:
    asyncio.run(_run())


if __name__ == "__main__":  # pragma: no cover
    main()
