"""The ExperimentSpec object model and paired trial-matrix design (experiment
substrate design doc section 7)."""

from .design import PlannedTrial, build_matrix, select_tasks, trial_seed
from .models import (
    AgentSpecSubject,
    DecisionPolicy,
    ExperimentMetadata,
    ExperimentObservation,
    ExperimentSpec,
    HardGates,
    MetricsBlock,
    ObservationMetric,
    SoftwareArtifactSubject,
    TaskSelector,
)
from .subjects import ObservationProvider

__all__ = [
    "AgentSpecSubject",
    "DecisionPolicy",
    "ExperimentObservation",
    "ExperimentMetadata",
    "ExperimentSpec",
    "HardGates",
    "MetricsBlock",
    "ObservationMetric",
    "ObservationProvider",
    "PlannedTrial",
    "SoftwareArtifactSubject",
    "TaskSelector",
    "build_matrix",
    "select_tasks",
    "trial_seed",
]
