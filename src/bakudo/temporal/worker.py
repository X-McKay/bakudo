"""The Temporal worker process entrypoint (``bakudo-worker``).

Connects to Temporal, optionally wires the durable Postgres ledger + Neo4j
graph into the activity layer, and serves the control and run task queues.
"""

from __future__ import annotations

import asyncio
import concurrent.futures


async def _run() -> None:
    from temporalio.client import Client
    from temporalio.worker import Worker

    from ..config import Settings
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

    settings = Settings.from_env()

    # Wire the durable ledger + memory if a DSN is configured (otherwise
    # in-memory). The Neo4j graph mirror rides along when NEO4J_URI is set.
    if settings.postgres_dsn:
        from ..memory.store_pg import PgSemanticMemoryStore
        from ..registry.postgres_ledger import PostgresLedger

        graph = None
        if settings.neo4j_uri:
            from ..memory.graph import Neo4jGraphMemory

            if not settings.neo4j_password:
                raise RuntimeError(
                    "NEO4J_URI is set but NEO4J_PASSWORD is not; refusing to "
                    "guess credentials for the graph memory mirror."
                )
            graph = Neo4jGraphMemory.connect(
                settings.neo4j_uri, settings.neo4j_user, settings.neo4j_password
            )

        _impl.configure(
            ledger=PostgresLedger.connect(settings.postgres_dsn),
            memory=PgSemanticMemoryStore.connect(settings.postgres_dsn, graph=graph),
        )

    client = await Client.connect(
        settings.temporal_address, namespace=settings.temporal_namespace
    )

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
        max_workers=settings.activity_threads,
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
    print(
        f"[bakudo-worker] serving {TASK_QUEUE_CONTROL} + {TASK_QUEUE_RUNS} "
        f"at {settings.temporal_address}"
    )
    await asyncio.gather(control.run(), runs.run())


def main() -> None:
    asyncio.run(_run())


if __name__ == "__main__":  # pragma: no cover
    main()
