"""The Temporal worker process entrypoint (``bakudo-worker``).

Connects to Temporal, optionally wires the durable Postgres ledger + Neo4j
graph into the activity layer, and serves the control and run task queues.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import os


async def _run() -> None:
    from temporalio.client import Client
    from temporalio.worker import Worker

    from . import _impl
    from .activities import ALL_ACTIVITIES
    from .shared import TASK_QUEUE_CONTROL, TASK_QUEUE_RUNS
    from .workflows import (
        AgentEvolutionWorkflow,
        AgentRunWorkflow,
        EvalWorkflow,
        MemoryCompactionWorkflow,
        MetaAgentWorkflow,
        OptimizationWorkflow,
        RepoObserverWorkflow,
    )

    # Wire the durable ledger + memory if a DSN is configured (otherwise
    # in-memory). The Neo4j graph mirror rides along when NEO4J_URI is set.
    dsn = os.environ.get("BAKUDO_POSTGRES_DSN")
    if dsn:
        from ..memory.store_pg import PgSemanticMemoryStore
        from ..registry.postgres_ledger import PostgresLedger

        graph = None
        neo4j_uri = os.environ.get("NEO4J_URI")
        if neo4j_uri:
            from ..memory.graph import Neo4jGraphMemory

            password = os.environ.get("NEO4J_PASSWORD")
            if not password:
                raise RuntimeError(
                    "NEO4J_URI is set but NEO4J_PASSWORD is not; refusing to "
                    "guess credentials for the graph memory mirror."
                )
            graph = Neo4jGraphMemory.connect(
                neo4j_uri, os.environ.get("NEO4J_USER", "neo4j"), password
            )

        _impl.configure(
            ledger=PostgresLedger.connect(dsn),
            memory=PgSemanticMemoryStore.connect(dsn, graph=graph),
        )

    address = os.environ.get("TEMPORAL_ADDRESS", "localhost:7233")
    namespace = os.environ.get("TEMPORAL_NAMESPACE", "default")
    client = await Client.connect(address, namespace=namespace)

    # Every registered workflow, including the evolution, compaction, and
    # observer workflows — unregistered they are unreachable dead code.
    control_workflows = [
        MetaAgentWorkflow,
        AgentRunWorkflow,
        EvalWorkflow,
        OptimizationWorkflow,
        AgentEvolutionWorkflow,
        MemoryCompactionWorkflow,
        RepoObserverWorkflow,
    ]
    run_workflows = [
        AgentRunWorkflow,
        EvalWorkflow,
        OptimizationWorkflow,
        AgentEvolutionWorkflow,
        MemoryCompactionWorkflow,
    ]

    # Activities are synchronous (they block on subprocesses and DB drivers),
    # so the SDK dispatches them to this executor instead of the event loop.
    activity_executor = concurrent.futures.ThreadPoolExecutor(
        max_workers=int(os.environ.get("BAKUDO_ACTIVITY_THREADS", "8")),
        thread_name_prefix="bakudo-activity",
    )

    control = Worker(
        client,
        task_queue=TASK_QUEUE_CONTROL,
        workflows=control_workflows,
        activities=ALL_ACTIVITIES,
        activity_executor=activity_executor,
    )
    runs = Worker(
        client,
        task_queue=TASK_QUEUE_RUNS,
        workflows=run_workflows,
        activities=ALL_ACTIVITIES,
        activity_executor=activity_executor,
    )
    print(f"[bakudo-worker] serving {TASK_QUEUE_CONTROL} + {TASK_QUEUE_RUNS} at {address}")
    await asyncio.gather(control.run(), runs.run())


def main() -> None:
    asyncio.run(_run())


if __name__ == "__main__":  # pragma: no cover
    main()
