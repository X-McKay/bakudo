"""Objective model and prioritization (spec sections 16.2 and 16.4)."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from .. import ids
from ..schema import validate_objective


class ObjectiveType(str, Enum):
    explore = "explore"
    add_feature = "add-feature"
    qa = "qa"
    critic = "critic"
    eval_author = "eval-author"
    skill_gen = "skill-gen"
    maintenance = "maintenance"
    optimize = "optimize"


class ObjectiveStatus(str, Enum):
    ready = "ready"
    blocked = "blocked"
    running = "running"
    completed = "completed"
    failed = "failed"
    archived = "archived"
    needs_human = "needs_human"

    def can_transition_to(self, other: ObjectiveStatus) -> bool:
        """Whether ``self -> other`` is a legal objective lifecycle move."""
        return other in _OBJECTIVE_TRANSITIONS[self]


# The explicit objective state machine (spec section 16.2). needs_human is an
# escalation reachable from any live state; a human resolves it back to ready
# (retry) or archived (drop).
_OBJECTIVE_TRANSITIONS: dict[ObjectiveStatus, frozenset[ObjectiveStatus]] = {
    ObjectiveStatus.ready: frozenset(
        {ObjectiveStatus.running, ObjectiveStatus.blocked,
         ObjectiveStatus.needs_human, ObjectiveStatus.archived}
    ),
    ObjectiveStatus.blocked: frozenset(
        {ObjectiveStatus.ready, ObjectiveStatus.needs_human, ObjectiveStatus.archived}
    ),
    ObjectiveStatus.running: frozenset(
        {ObjectiveStatus.completed, ObjectiveStatus.failed, ObjectiveStatus.needs_human}
    ),
    ObjectiveStatus.failed: frozenset(
        {ObjectiveStatus.ready, ObjectiveStatus.needs_human, ObjectiveStatus.archived}
    ),
    ObjectiveStatus.needs_human: frozenset(
        {ObjectiveStatus.ready, ObjectiveStatus.archived}
    ),
    ObjectiveStatus.completed: frozenset({ObjectiveStatus.archived}),
    ObjectiveStatus.archived: frozenset(),
}


@dataclass(frozen=True)
class PriorityWeights:
    """Coefficients for the priority formula (spec section 16.4).

    Note the two negative terms (``risk`` and ``estimated_cost``) are stored as
    positive weights and subtracted in :meth:`Priority.compute`.
    """

    user_value: float = 0.35
    urgency: float = 0.20
    learning_value: float = 0.15
    confidence: float = 0.15
    dependency_unblocking_value: float = 0.10
    risk: float = 0.25
    estimated_cost: float = 0.10


DEFAULT_WEIGHTS = PriorityWeights()


class Priority(BaseModel):
    """The 0..1 signal components used to rank objectives."""

    model_config = ConfigDict(populate_by_name=True)

    value: float = Field(default=0.0, ge=0.0, le=1.0)
    urgency: float = Field(default=0.0, ge=0.0, le=1.0)
    learning_value: float = Field(default=0.0, alias="learningValue", ge=0.0, le=1.0)
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    dependency_unblocking_value: float = Field(
        default=0.0, alias="dependencyUnblockingValue", ge=0.0, le=1.0
    )
    risk: float = Field(default=0.0, ge=0.0, le=1.0)
    novelty: float = Field(default=0.0, ge=0.0, le=1.0)
    estimated_cost: float = Field(default=0.0, alias="estimatedCost", ge=0.0, le=1.0)
    score: float | None = None

    def compute(self, weights: PriorityWeights = DEFAULT_WEIGHTS) -> float:
        """Compute the priority score per the spec formula.

            priority =
              0.35 * user_value + 0.20 * urgency + 0.15 * learning_value +
              0.15 * confidence + 0.10 * dependency_unblocking_value -
              0.25 * risk - 0.10 * estimated_cost
        """
        return (
            weights.user_value * self.value
            + weights.urgency * self.urgency
            + weights.learning_value * self.learning_value
            + weights.confidence * self.confidence
            + weights.dependency_unblocking_value * self.dependency_unblocking_value
            - weights.risk * self.risk
            - weights.estimated_cost * self.estimated_cost
        )


class Constraints(BaseModel):
    model_config = ConfigDict(extra="allow", populate_by_name=True)

    max_files_changed: int | None = Field(default=None, alias="maxFilesChanged")
    avoid_public_api_changes: bool | None = Field(
        default=None, alias="avoidPublicApiChanges"
    )
    # Optimize-role fields: the benchmark to run before/after, and the paths
    # the optimization is allowed to touch.
    bench_command: str | None = Field(default=None, alias="benchCommand")
    target_paths: list[str] | None = Field(default=None, alias="targetPaths")


class Objective(BaseModel):
    """A unit of work the system can attempt."""

    model_config = ConfigDict(populate_by_name=True)

    id: str = Field(default_factory=ids.objective_id)
    type: ObjectiveType
    repo: str
    title: str
    description: str = ""
    acceptance_criteria: list[str] = Field(
        default_factory=list, alias="acceptanceCriteria"
    )
    constraints: Constraints = Field(default_factory=Constraints)
    suggested_agents: list[str] = Field(default_factory=list, alias="suggestedAgents")
    depends_on: list[str] = Field(default_factory=list, alias="dependsOn")
    priority: Priority = Field(default_factory=Priority)
    status: ObjectiveStatus = ObjectiveStatus.ready

    def scored(self, weights: PriorityWeights = DEFAULT_WEIGHTS) -> Objective:
        """Return a copy with ``priority.score`` populated."""
        updated = self.priority.model_copy(update={"score": self.priority.compute(weights)})
        return self.model_copy(update={"priority": updated})

    def to_dict(self) -> dict[str, Any]:
        return self.model_dump(by_alias=True, exclude_none=True, mode="json")

    def validate_against_schema(self) -> None:
        validate_objective(self.to_dict())


def rank(
    objectives: list[Objective], weights: PriorityWeights = DEFAULT_WEIGHTS
) -> list[Objective]:
    """Return objectives sorted by descending computed priority score."""
    return sorted(
        (o.scored(weights) for o in objectives),
        key=lambda o: o.priority.score or 0.0,
        reverse=True,
    )
