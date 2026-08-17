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
    """Start the singleton MetaAgentWorkflow if it is not already running.

    ``USE_EXISTING`` makes this idempotent (TMP-7): a second call attaches to
    the running singleton instead of raising WorkflowAlreadyStartedError.
    """
    from temporalio.common import WorkflowIDConflictPolicy

    from .shared import TASK_QUEUE_CONTROL
    from .workflows import MetaAgentWorkflow

    return await client.start_workflow(
        MetaAgentWorkflow.run,
        id=META_WORKFLOW_ID,
        task_queue=TASK_QUEUE_CONTROL,
        id_conflict_policy=WorkflowIDConflictPolicy.USE_EXISTING,
    )


async def submit_objective(client: Any, objective: dict[str, Any]) -> str:
    handle = client.get_workflow_handle(META_WORKFLOW_ID)
    from .workflows import MetaAgentWorkflow

    return await handle.execute_update(MetaAgentWorkflow.submit_objective, objective)


async def get_status(client: Any) -> dict[str, Any]:
    handle = client.get_workflow_handle(META_WORKFLOW_ID)
    from .workflows import MetaAgentWorkflow

    return await handle.query(MetaAgentWorkflow.get_status)


async def start_optimization(client: Any, inp: Any) -> Any:
    """Start an OptimizationWorkflow for one optimize objective.

    ``inp`` is a :class:`~bakudo.temporal.shared.OptimizeInput`; the workflow
    id is derived from the objective id so resubmitting the same objective
    dedupes instead of racing itself.
    """
    from .shared import TASK_QUEUE_RUNS
    from .workflows import OptimizationWorkflow

    return await client.start_workflow(
        OptimizationWorkflow.run,
        inp,
        id=f"optimize-{inp.objective['id']}",
        task_queue=TASK_QUEUE_RUNS,
    )


async def start_trial(client: Any, inp: Any) -> Any:
    """Start a TrialWorkflow: run one task against one agent version.

    ``inp`` is a :class:`~bakudo.temporal.shared.TrialInput`. Unlike
    ``start_optimization``'s objective-id-derived id, a trial has no natural
    dedupe key (the same task/agent/seed can legitimately run more than
    once), so the workflow id carries a fresh UUID.
    """
    import uuid

    from .shared import TASK_QUEUE_RUNS
    from .workflows import TrialWorkflow

    return await client.start_workflow(
        TrialWorkflow.run,
        inp,
        id=f"trial-{uuid.uuid4().hex}",
        task_queue=TASK_QUEUE_RUNS,
    )


async def start_experiment(client: Any, inp: Any) -> Any:
    """Start an ExperimentWorkflow over one ExperimentSpec.

    ``inp`` is a :class:`~bakudo.temporal.shared.ExperimentInput`.
    """
    import uuid

    from .shared import TASK_QUEUE_RUNS
    from .workflows import ExperimentWorkflow

    return await client.start_workflow(
        ExperimentWorkflow.run,
        inp,
        id=f"experiment-{uuid.uuid4().hex}",
        task_queue=TASK_QUEUE_RUNS,
    )
