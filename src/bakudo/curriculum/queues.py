"""The multiple objective queues the system maintains (spec section 16.3)."""

from __future__ import annotations

from collections import defaultdict
from enum import Enum

from .objective import DEFAULT_WEIGHTS, Objective, PriorityWeights, rank


class QueueName(str, Enum):
    ready = "ready"
    blocked = "blocked"
    eval_generation = "eval-generation"
    skill_generation = "skill-generation"
    maintenance = "maintenance"
    human_review = "human-review"


class ObjectiveQueues:
    """A small in-memory router of objectives into named queues.

    The control plane mirrors these into Postgres; this structure exists so the
    meta-agent workflow can reason about the backlog deterministically.
    """

    def __init__(self, weights: PriorityWeights = DEFAULT_WEIGHTS) -> None:
        self._weights = weights
        self._queues: dict[QueueName, list[Objective]] = defaultdict(list)

    def add(self, objective: Objective, queue: QueueName = QueueName.ready) -> None:
        self._queues[queue].append(objective)

    def ranked(self, queue: QueueName = QueueName.ready) -> list[Objective]:
        """Objectives in a queue, highest priority first."""
        return rank(self._queues.get(queue, []), self._weights)

    def next_ready(self) -> Objective | None:
        """The single highest-priority ready objective, if any."""
        ordered = self.ranked(QueueName.ready)
        return ordered[0] if ordered else None

    def counts(self) -> dict[str, int]:
        return {q.value: len(items) for q, items in self._queues.items()}
