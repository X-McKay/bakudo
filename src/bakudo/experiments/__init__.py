"""The ExperimentSpec object model and paired trial-matrix design (experiment
substrate design doc section 7)."""

from .design import PlannedTrial, analysis_seed, build_matrix, select_tasks, trial_seed
from .models import (
    DEFAULT_MIN_PAIRED_OBSERVATIONS,
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
    "DEFAULT_MIN_PAIRED_OBSERVATIONS",
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
    "analysis_seed",
    "build_matrix",
    "select_tasks",
    "trial_seed",
]
