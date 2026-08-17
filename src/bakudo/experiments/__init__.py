"""The ExperimentSpec object model and paired trial-matrix design (experiment
substrate design doc section 7)."""

from .design import PlannedTrial, build_matrix, select_tasks, trial_seed
from .models import (
    DecisionPolicy,
    ExperimentMetadata,
    ExperimentSpec,
    HardGates,
    MetricsBlock,
    TaskSelector,
)

__all__ = [
    "DecisionPolicy",
    "ExperimentMetadata",
    "ExperimentSpec",
    "HardGates",
    "MetricsBlock",
    "PlannedTrial",
    "TaskSelector",
    "build_matrix",
    "select_tasks",
    "trial_seed",
]
