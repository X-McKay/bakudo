"""Temporal orchestration: the durable backbone (spec section 11).

This package is import-light on purpose: ``temporalio`` is only required when
you actually run the worker (:mod:`bakudo.temporal.worker`) or build workflows.
The data contracts in :mod:`bakudo.temporal.shared` import without it.
"""

from .shared import (
    TASK_QUEUE_CONTROL,
    TASK_QUEUE_RUNS,
    AgentRunInput,
    AgentRunOutput,
    EvalInput,
)

__all__ = [
    "AgentRunInput",
    "AgentRunOutput",
    "EvalInput",
    "TASK_QUEUE_CONTROL",
    "TASK_QUEUE_RUNS",
]
