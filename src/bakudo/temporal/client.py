"""Client helpers for driving the MetaAgentWorkflow from the API/CLI."""

from __future__ import annotations

import os
from typing import Any

META_WORKFLOW_ID = "bakudo-meta-agent"


async def connect() -> Any:
    from temporalio.client import Client

    address = os.environ.get("TEMPORAL_ADDRESS", "localhost:7233")
    namespace = os.environ.get("TEMPORAL_NAMESPACE", "default")
    return await Client.connect(address, namespace=namespace)


async def ensure_meta_agent(client: Any) -> Any:
    """Start the singleton MetaAgentWorkflow if it is not already running."""
    from .shared import TASK_QUEUE_CONTROL
    from .workflows import MetaAgentWorkflow

    return await client.start_workflow(
        MetaAgentWorkflow.run,
        id=META_WORKFLOW_ID,
        task_queue=TASK_QUEUE_CONTROL,
        # id_reuse_policy avoids duplicate singletons; the SDK no-ops if running.
    )


async def submit_objective(client: Any, objective: dict[str, Any]) -> str:
    handle = client.get_workflow_handle(META_WORKFLOW_ID)
    from .workflows import MetaAgentWorkflow

    return await handle.execute_update(MetaAgentWorkflow.submit_objective, objective)


async def get_status(client: Any) -> dict[str, Any]:
    handle = client.get_workflow_handle(META_WORKFLOW_ID)
    from .workflows import MetaAgentWorkflow

    return await handle.query(MetaAgentWorkflow.get_status)
