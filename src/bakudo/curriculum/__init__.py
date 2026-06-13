"""The curriculum engine: what the system should work on next (spec section 16)."""

from .objective import Objective, ObjectiveType, Priority, PriorityWeights
from .queues import ObjectiveQueues, QueueName

__all__ = [
    "Objective",
    "ObjectiveType",
    "Priority",
    "PriorityWeights",
    "QueueName",
    "ObjectiveQueues",
]
