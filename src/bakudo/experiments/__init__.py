"""The ExperimentSpec object model and paired trial-matrix design (experiment
substrate design doc section 7)."""

from .design import PlannedTrial, build_matrix, select_scenarios, trial_seed
from .models import (
    DecisionPolicy,
    ExperimentMetadata,
    ExperimentSpec,
    HardGates,
    MetricsBlock,
    ScenarioSelector,
)

__all__ = [
    "DecisionPolicy",
    "ExperimentMetadata",
    "ExperimentSpec",
    "HardGates",
    "MetricsBlock",
    "PlannedTrial",
    "ScenarioSelector",
    "build_matrix",
    "select_scenarios",
    "trial_seed",
]
