"""Strict contracts for agent and software-artifact experiments."""

from __future__ import annotations

import math
from typing import Annotated, Any, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    field_validator,
    model_validator,
)

from ..performance.models import MetricDirection, MetricName, RevisionPin, WorkloadRef
from ..trials.models import TrialRecord

AgentRef = Annotated[str, StringConstraints(min_length=1, max_length=256)]
MeasurementId = Annotated[
    str, StringConstraints(pattern=r"^measurement_[0-9A-HJKMNP-TV-Z]{26}$")
]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class _StrictFrozen(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)


class ExperimentMetadata(_Strict):
    name: Annotated[str, StringConstraints(min_length=1, max_length=128)]


class TaskSelector(_Strict):
    """Deterministic task-corpus selection for an agent-spec subject."""

    families: list[str] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)
    partitions: list[str] = Field(default_factory=lambda: ["dev", "validation"])
    count: int = Field(default=20, ge=1)


class AgentSpecSubject(_Strict):
    """Task-backed comparison of agent-spec versions."""

    kind: Literal["agent-spec"] = "agent-spec"
    baseline: AgentRef
    candidates: list[AgentRef] = Field(default_factory=list)
    task_selector: TaskSelector = Field(default_factory=TaskSelector, alias="taskSelector")
    use_holdout: bool = Field(default=False, alias="useHoldout")

    @model_validator(mode="after")
    def distinct_arms(self) -> AgentSpecSubject:
        if len(self.candidates) != len(set(self.candidates)):
            raise ValueError("agent candidates must be unique")
        if self.baseline in self.candidates:
            raise ValueError("agent baseline cannot also be a candidate")
        return self


class SoftwareArtifactSubject(_Strict):
    """Workload-backed comparison of immutable software revisions."""

    kind: Literal["software-artifact"] = "software-artifact"
    repository: Annotated[str, StringConstraints(min_length=1, max_length=256)]
    baseline: RevisionPin
    candidates: list[RevisionPin] = Field(min_length=1, max_length=32)
    workload_ref: WorkloadRef = Field(alias="workloadRef")

    @model_validator(mode="after")
    def revisions_match_repository(self) -> SoftwareArtifactSubject:
        revisions = (self.baseline, *self.candidates)
        if any(revision.repository != self.repository for revision in revisions):
            raise ValueError("all artifact revisions must match subject.repository")
        if len(self.candidates) != len(set(self.candidates)):
            raise ValueError("artifact candidates must be unique")
        if self.baseline in self.candidates:
            raise ValueError("artifact baseline cannot also be a candidate")
        return self


ExperimentSubject = Annotated[
    AgentSpecSubject | SoftwareArtifactSubject,
    Field(discriminator="kind"),
]


class MetricsBlock(_Strict):
    primary: MetricName = "task_success"
    secondary: list[MetricName] = Field(default_factory=list, max_length=64)
    directions: dict[MetricName, MetricDirection] = Field(default_factory=dict)

    @model_validator(mode="after")
    def unique_metrics(self) -> MetricsBlock:
        if len(self.secondary) != len(set(self.secondary)):
            raise ValueError("secondary metrics must be unique")
        if self.primary in self.secondary:
            raise ValueError("primary metric cannot also be secondary")
        declared = {self.primary, *self.secondary}
        unknown = sorted(set(self.directions) - declared)
        if unknown:
            raise ValueError(f"metric directions reference undeclared metrics: {unknown}")
        return self

    def direction_for(self, name: str) -> MetricDirection:
        return self.directions.get(name, MetricDirection.higher_is_better)


class HardGates(_Strict):
    safety_regressions: int = Field(default=0, alias="safetyRegressions", ge=0)
    integrity_violations: int = Field(default=0, alias="integrityViolations", ge=0)


class DecisionPolicy(_Strict):
    confidence: float = Field(default=0.95, gt=0, lt=1)
    tie_zone: float = Field(default=0.10, alias="tieZone", ge=0)
    cost_tiebreak: bool = Field(default=True, alias="costTiebreak")
    bootstrap_resamples: int = Field(
        default=10_000, alias="bootstrapResamples", ge=1, le=1_000_000
    )


_TASK_REWARD_METRICS = frozenset(
    {"task_success", "reward", "f2p_rate", "p2p_rate", "scorecard"}
)


class ExperimentSpec(_Strict):
    api_version: Literal["bakudo.ai/v1alpha1"] = Field(
        default="bakudo.ai/v1alpha1", alias="apiVersion"
    )
    kind: Literal["ExperimentSpec"] = "ExperimentSpec"
    metadata: ExperimentMetadata
    subject: ExperimentSubject
    repetitions: int = Field(default=1, ge=1, le=10_000)
    metrics: MetricsBlock = Field(default_factory=MetricsBlock)
    hard_gates: HardGates = Field(default_factory=HardGates, alias="hardGates")
    decision: DecisionPolicy = Field(default_factory=DecisionPolicy)

    @model_validator(mode="after")
    def subject_metric_contract(self) -> ExperimentSpec:
        if isinstance(self.subject, SoftwareArtifactSubject):
            names = {self.metrics.primary, *self.metrics.secondary}
            forbidden = sorted(names & _TASK_REWARD_METRICS)
            if forbidden:
                raise ValueError(
                    "software-artifact metrics cannot reference task rewards: "
                    + ", ".join(forbidden)
                )
        return self

    @property
    def profile(self) -> bool:
        return isinstance(self.subject, AgentSpecSubject) and not self.subject.candidates

    def to_dict(self) -> dict[str, Any]:
        return self.model_dump(by_alias=True, exclude_none=True, mode="json")


class ObservationMetric(_StrictFrozen):
    """One named observation with its original optimization direction."""

    name: MetricName
    value: float | None = None
    direction: MetricDirection
    valid: bool = True
    invalid_reasons: tuple[str, ...] = Field(
        default_factory=tuple, alias="invalidReasons", max_length=64
    )

    @field_validator("value")
    @classmethod
    def finite_value(cls, value: float | None) -> float | None:
        if value is not None and not math.isfinite(value):
            raise ValueError("observation metric values must be finite")
        return value

    @model_validator(mode="after")
    def validity_is_explicit(self) -> ObservationMetric:
        if self.valid and self.value is None:
            raise ValueError("valid observation metrics require a value")
        if not self.valid and not self.invalid_reasons:
            raise ValueError("invalid observation metrics require a reason")
        return self

    @property
    def normalized_value(self) -> float | None:
        if self.value is None:
            return None
        if self.direction is MetricDirection.lower_is_better:
            return -self.value
        return self.value


class AgentTrialEvidence(_StrictFrozen):
    kind: Literal["trial-record"] = "trial-record"
    trial: TrialRecord


class MeasurementRecordEvidence(_StrictFrozen):
    kind: Literal["measurement-record"] = "measurement-record"
    measurement_id: MeasurementId = Field(alias="measurementId")


ObservationEvidence = Annotated[
    AgentTrialEvidence | MeasurementRecordEvidence,
    Field(discriminator="kind"),
]


class ExperimentObservation(_StrictFrozen):
    """Subject-neutral envelope consumed by experiment statistics."""

    experiment_id: str = Field(alias="experimentId")
    subject_kind: Literal["agent-spec", "software-artifact"] = Field(alias="subjectKind")
    arm: Annotated[str, StringConstraints(min_length=1, max_length=256)]
    pair_key: Annotated[str, StringConstraints(min_length=1, max_length=512)] = Field(
        alias="pairKey"
    )
    repetition: int = Field(ge=0)
    metrics: tuple[ObservationMetric, ...] = Field(min_length=1, max_length=65)
    integrity_valid: bool = Field(default=True, alias="integrityValid")
    degraded: bool = False
    degradation_reasons: tuple[str, ...] = Field(
        default_factory=tuple, alias="degradationReasons", max_length=128
    )
    evidence: ObservationEvidence

    @model_validator(mode="after")
    def coherent_envelope(self) -> ExperimentObservation:
        names = [metric.name for metric in self.metrics]
        if len(names) != len(set(names)):
            raise ValueError("observation metrics must have unique names")
        if self.degraded and not self.degradation_reasons:
            raise ValueError("degraded observations require a reason")
        expected = (
            "trial-record" if self.subject_kind == "agent-spec" else "measurement-record"
        )
        if self.evidence.kind != expected:
            raise ValueError("observation evidence kind does not match subject kind")
        return self

    def metric(self, name: str) -> ObservationMetric | None:
        return next((metric for metric in self.metrics if metric.name == name), None)
