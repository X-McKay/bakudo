"""The Temporal worker process entrypoint (``bakudo-worker``).

Connects to Temporal, optionally wires the durable Postgres ledger + Neo4j
graph into the activity layer, and serves the control and run task queues.
"""

from __future__ import annotations

import asyncio
import os
from concurrent.futures import ThreadPoolExecutor
from typing import Any

# Sandbox runs can hold an activity thread for hours; size the pool so long
# runs do not starve the quick ledger-write activities on the same queue.
_ACTIVITY_POOL_SIZE = 16


def worker_configs() -> list[dict[str, Any]]:
    """Worker kwargs for both task queues (shared by the entrypoint and tests).

    Every activity is a blocking sync ``def`` (subprocess sandbox runs, sync
    psycopg, httpx), so each worker gets its own ``ThreadPoolExecutor`` as
    ``activity_executor`` (TMP-1) — otherwise one 2h sandbox run would freeze
    the event loop both task queues share.
    """
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

    # Every control-plane workflow type must be registered here, or client
    # starts hang with "workflow type not registered" (TMP-4).
    control_workflows: list[type] = [
        MetaAgentWorkflow,
        AgentRunWorkflow,
        EvalWorkflow,
        OptimizationWorkflow,
        AgentEvolutionWorkflow,
        MemoryCompactionWorkflow,
        RepoObserverWorkflow,
    ]
    run_workflows: list[type] = [AgentRunWorkflow, EvalWorkflow, OptimizationWorkflow]

    return [
        dict(
            task_queue=TASK_QUEUE_CONTROL,
            workflows=control_workflows,
            activities=ALL_ACTIVITIES,
            activity_executor=ThreadPoolExecutor(
                max_workers=_ACTIVITY_POOL_SIZE, thread_name_prefix="bakudo-act-control"
            ),
        ),
        dict(
            task_queue=TASK_QUEUE_RUNS,
            workflows=run_workflows,
            activities=ALL_ACTIVITIES,
            activity_executor=ThreadPoolExecutor(
                max_workers=_ACTIVITY_POOL_SIZE, thread_name_prefix="bakudo-act-runs"
            ),
        ),
    ]


def _resolve_embedder() -> Any | None:
    """Resolve the production embedder for the durable memory store.

    Called only when ``BAKUDO_POSTGRES_DSN`` is set. ``VLLM_EMBED_URL`` is
    then mandatory: a durable store silently falling back to the lexical
    HashingEmbedder is exactly the MEM-1 failure mode. ``OpenAIEmbedder`` is
    resolved defensively — until it lands in ``bakudo.memory.embeddings``,
    returns None and the store keeps its current default.
    """
    url = os.environ.get("VLLM_EMBED_URL")
    if not url:
        raise RuntimeError(
            "BAKUDO_POSTGRES_DSN is set but VLLM_EMBED_URL is not. The durable "
            "memory store requires the embeddings endpoint; set VLLM_EMBED_URL "
            "(e.g. the vLLM /v1 base URL for the embedding model)."
        )
    from ..memory import embeddings

    embedder_cls = getattr(embeddings, "OpenAIEmbedder", None)
    if embedder_cls is None:
        return None
    return embedder_cls(base_url=url)


def _wire_dependencies() -> None:
    """Wire the durable ledger + memory if a DSN is configured (otherwise
    in-memory). The Neo4j graph mirror rides along when NEO4J_URI is set."""
    from . import _impl

    dsn = os.environ.get("BAKUDO_POSTGRES_DSN")
    if not dsn:
        return

    embedder = _resolve_embedder()

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
        memory=PgSemanticMemoryStore.connect(dsn, graph=graph, embedder=embedder),
    )


async def _run() -> None:
    from temporalio.client import Client
    from temporalio.worker import Worker

    from .shared import TASK_QUEUE_CONTROL, TASK_QUEUE_RUNS

    _wire_dependencies()

    address = os.environ.get("TEMPORAL_ADDRESS", "localhost:7233")
    namespace = os.environ.get("TEMPORAL_NAMESPACE", "default")
    client = await Client.connect(address, namespace=namespace)

    workers = [Worker(client, **cfg) for cfg in worker_configs()]
    print(f"[bakudo-worker] serving {TASK_QUEUE_CONTROL} + {TASK_QUEUE_RUNS} at {address}")
    await asyncio.gather(*(w.run() for w in workers))


def main() -> None:
    asyncio.run(_run())


if __name__ == "__main__":  # pragma: no cover
    main()
