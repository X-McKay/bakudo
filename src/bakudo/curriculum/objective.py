"""Objective model and prioritization (spec sections 16.2 and 16.4)."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import TYPE_CHECKING, Annotated, Any

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

from .. import ids
from ..performance.models import MetricName, WorkloadPin, WorkloadRef
from ..schema import validate_objective

if TYPE_CHECKING:
    from ..performance.regressions import PerformanceObjectiveInput


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
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    max_files_changed: int | None = Field(
        default=None, alias="maxFilesChanged", ge=0
    )
    avoid_public_api_changes: bool | None = Field(
        default=None, alias="avoidPublicApiChanges"
    )
    target_paths: list[str] | None = Field(default=None, alias="targetPaths")


class PerformanceDecisionPolicy(BaseModel):
    """Fail-closed statistical policy for independent candidate measurement."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    confidence: float = Field(default=0.95, gt=0, lt=1)
    minimum_relative_improvement: float = Field(
        default=0.05, alias="minimumRelativeImprovement", ge=0
    )
    protected_metrics: tuple[MetricName, ...] = Field(
        default_factory=tuple, alias="protectedMetrics", max_length=64
    )
    bootstrap_resamples: int = Field(
        default=10_000, alias="bootstrapResamples", ge=1, le=1_000_000
    )

    @model_validator(mode="after")
    def unique_protected_metrics(self) -> PerformanceDecisionPolicy:
        if len(self.protected_metrics) != len(set(self.protected_metrics)):
            raise ValueError("protectedMetrics must contain unique metric names")
        return self


class PerformanceContract(BaseModel):
    """Trusted workload and decision policy bound to an optimize objective."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    workload_ref: WorkloadRef = Field(alias="workloadRef")
    workload_pin: WorkloadPin | None = Field(default=None, alias="workloadPin")
    primary_metric: MetricName = Field(alias="primaryMetric")
    decision_policy: PerformanceDecisionPolicy = Field(
        default_factory=PerformanceDecisionPolicy, alias="decisionPolicy"
    )
    comparison_id: Annotated[
        str, StringConstraints(pattern=r"^comparison_[0-9A-HJKMNP-TV-Z]{26}$")
    ] | None = Field(default=None, alias="comparisonId")
    regression_signal_id: Annotated[
        str, StringConstraints(pattern=r"^regression_[0-9A-HJKMNP-TV-Z]{26}$")
    ] | None = Field(default=None, alias="regressionSignalId")

    @model_validator(mode="after")
    def pin_matches_reference(self) -> PerformanceContract:
        if self.workload_pin is not None and (
            self.workload_pin.name != self.workload_ref.name
            or self.workload_pin.version != self.workload_ref.version
        ):
            raise ValueError("workloadPin name/version must match workloadRef")
        return self


class Objective(BaseModel):
    """A unit of work the system can attempt."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    id: str = Field(default_factory=ids.objective_id)
    type: ObjectiveType
    repo: str
    title: str
    description: str = ""
    acceptance_criteria: list[str] = Field(
        default_factory=list, alias="acceptanceCriteria"
    )
    constraints: Constraints = Field(default_factory=Constraints)
    performance: PerformanceContract | None = None
    suggested_agents: list[str] = Field(default_factory=list, alias="suggestedAgents")
    depends_on: list[str] = Field(default_factory=list, alias="dependsOn")
    priority: Priority = Field(default_factory=Priority)
    status: ObjectiveStatus = ObjectiveStatus.ready

    @model_validator(mode="after")
    def optimize_requires_performance_contract(self) -> Objective:
        if self.type is ObjectiveType.optimize and self.performance is None:
            raise ValueError("optimize objectives require a performance contract")
        return self

    def scored(self, weights: PriorityWeights = DEFAULT_WEIGHTS) -> Objective:
        """Return a copy with ``priority.score`` populated."""
        updated = self.priority.model_copy(update={"score": self.priority.compute(weights)})
        return self.model_copy(update={"priority": updated})

    def to_dict(self) -> dict[str, Any]:
        return self.model_dump(by_alias=True, exclude_none=True, mode="json")

    def validate_against_schema(self) -> None:
        validate_objective(self.to_dict())


def objective_from_performance_input(value: PerformanceObjectiveInput) -> Objective:
    """Build a schema-valid optimize objective from approved regression input.

    The handoff deliberately accepts the already-approved, typed input rather
    than reconstructing policy from a regression signal. This preserves the
    exact workload pin and comparison lineage selected by the collector.
    """

    objective = Objective(
        id=value.id,
        type=ObjectiveType.optimize,
        repo=value.repo,
        title=value.title,
        description=value.description,
        constraints=Constraints(target_paths=list(value.target_paths)),
        performance=PerformanceContract(
            workload_ref=value.performance.workload_ref,
            workload_pin=value.performance.workload_pin,
            primary_metric=value.performance.primary_metric,
            decision_policy=PerformanceDecisionPolicy(
                confidence=value.performance.decision_policy.confidence,
                minimum_relative_improvement=(
                    value.performance.decision_policy.minimum_relative_improvement
                ),
                protected_metrics=value.performance.decision_policy.protected_metrics,
            ),
            comparison_id=value.performance.evidence.comparison_id,
            regression_signal_id=value.performance.evidence.regression_signal_id,
        ),
        suggested_agents=list(value.suggested_agents),
        priority=Priority(
            value=value.priority.value,
            urgency=value.priority.urgency,
            confidence=value.priority.confidence,
            risk=value.priority.risk,
            estimated_cost=value.priority.estimated_cost,
        ),
    )
    objective.validate_against_schema()
    return objective


def rank(
    objectives: list[Objective], weights: PriorityWeights = DEFAULT_WEIGHTS
) -> list[Objective]:
    """Return objectives sorted by descending computed priority score."""
    return sorted(
        (o.scored(weights) for o in objectives),
        key=lambda o: o.priority.score or 0.0,
        reverse=True,
    )
