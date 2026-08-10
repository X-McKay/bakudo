"""The Temporal worker process entrypoint (``bakudo-worker``).

Connects to Temporal, optionally wires the durable Postgres ledger + Neo4j
graph into the activity layer, and serves the control and run task queues.
"""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
from concurrent.futures import ThreadPoolExecutor
from typing import Any

logger = logging.getLogger(__name__)

# Sandbox runs can hold an activity thread for hours; size the pool so long
# runs do not starve the quick ledger-write activities on the same queue.
_ACTIVITY_POOL_SIZE = 16


def log_sandbox_posture() -> None:
    """Announce the worker's sandbox posture at startup (TMP-13).

    The compose worker image ships no abox binary/KVM, so the composed stack
    declares ``BAKUDO_SANDBOX=unavailable``. The worker still starts (ledger
    writes, evals-on-stored-results, curriculum, memory compaction all work),
    but every sandbox-requiring activity fails fast with an actionable error
    — this log makes that posture visible in ``docker compose logs worker``
    instead of surfacing only when the first run fails.
    """
    mode = os.environ.get("BAKUDO_SANDBOX")
    if mode is None and os.environ.get("BAKUDO_USE_ABOX") == "1":
        mode = "abox"

    if mode == "unavailable":
        logger.warning(
            "sandbox posture: DEGRADED (BAKUDO_SANDBOX=unavailable). Sandbox "
            "runs are unavailable: this deployment has no abox binary and no "
            "KVM. The worker serves non-sandbox activities; every "
            "sandbox-requiring run will fail fast with an actionable error. "
            "To enable real sandboxing, mount the host abox binary and "
            "/dev/kvm into the worker and set BAKUDO_SANDBOX=abox "
            "(see infra/docker-compose.yml)."
        )
    elif mode == "abox":
        resolved = shutil.which("abox")
        if resolved is None:
            logger.warning(
                "sandbox posture: BAKUDO_SANDBOX=abox but the abox binary "
                "was not found on PATH — every sandbox run will fail with "
                "AboxNotFoundError. Install abox 0.6.0 (and expose /dev/kvm "
                "when containerized) or set BAKUDO_SANDBOX=unavailable to "
                "declare the degraded mode."
            )
        else:
            logger.info("sandbox posture: abox microVM sandbox (%s)", resolved)
    elif mode == "local":
        logger.info(
            "sandbox posture: in-process local sandbox (dev-only; requires "
            "BAKUDO_ENV=dev, not an isolation boundary)"
        )
    else:
        logger.warning(
            "sandbox posture: BAKUDO_SANDBOX is not set (fail-closed) — "
            "every sandbox-requiring run will be refused. Set it to 'abox', "
            "'local' (dev-only), or 'unavailable' to declare a degraded "
            "deployment."
        )


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

    log_sandbox_posture()
    _wire_dependencies()

    address = os.environ.get("TEMPORAL_ADDRESS", "localhost:7233")
    namespace = os.environ.get("TEMPORAL_NAMESPACE", "default")
    client = await Client.connect(address, namespace=namespace)

    workers = [Worker(client, **cfg) for cfg in worker_configs()]
    print(f"[bakudo-worker] serving {TASK_QUEUE_CONTROL} + {TASK_QUEUE_RUNS} at {address}")
    await asyncio.gather(*(w.run() for w in workers))


def main() -> None:
    # The sandbox-posture warning (TMP-13) must reach `docker compose logs`
    # even in a bare container with no logging config of its own.
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
    )
    asyncio.run(_run())


if __name__ == "__main__":  # pragma: no cover
    main()
