"""The curriculum engine: what the system should work on next (spec section 16)."""

from .objective import Objective, ObjectiveType, Priority, PriorityWeights
from .observe import (
    Advisory,
    CoverageGap,
    FailingTest,
    Issue,
    RepoSignals,
    Todo,
    generate_objectives,
)
from .queues import ObjectiveQueues, QueueName

__all__ = [
    "Objective",
    "ObjectiveType",
    "Priority",
    "PriorityWeights",
    "QueueName",
    "ObjectiveQueues",
    "RepoSignals",
    "Issue",
    "FailingTest",
    "Todo",
    "CoverageGap",
    "Advisory",
    "generate_objectives",
]
