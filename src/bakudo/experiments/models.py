"""Pydantic models mirroring ``schemas/experiment-spec.schema.json``.

An :class:`ExperimentSpec` is a versioned, camelCase-aliased spec model —
the same family as :class:`~bakudo.tasks.models.TaskSpec` (a
configuration a human or the meta-agent authors), not a snake_case ledger
record like :class:`~bakudo.trials.models.TrialRecord`. It describes a
baseline-vs-candidate comparison (or, with an empty ``candidates`` list, a
baseline-only profile run) over a deterministic task selection
(experiment substrate design doc section 7). The JSON Schema remains the
cross-language source of truth (see
:func:`bakudo.schema.validate_experiment_spec`).
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class ExperimentMetadata(_Strict):
    name: str


class TaskSelector(_Strict):
    """Which tasks an experiment's matrix is built from.

    Every field defaults so a caller can request "the standard slice"
    (``dev``/``validation``, no family or tag narrowing, 20 tasks) with
    an empty selector.
    """

    families: list[str] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)
    partitions: list[str] = Field(default_factory=lambda: ["dev", "validation"])
    count: int = Field(default=20, ge=1)


class MetricsBlock(_Strict):
    primary: str = "task_success"
    secondary: list[str] = Field(default_factory=list)


class HardGates(_Strict):
    safety_regressions: int = Field(default=0, alias="safetyRegressions", ge=0)
    integrity_violations: int = Field(default=0, alias="integrityViolations", ge=0)


class DecisionPolicy(_Strict):
    confidence: float = 0.95
    tie_zone: float = Field(default=0.10, alias="tieZone")
    cost_tiebreak: bool = Field(default=True, alias="costTiebreak")


class ExperimentSpec(_Strict):
    api_version: str = Field(default="bakudo.ai/v1alpha1", alias="apiVersion")
    kind: str = "ExperimentSpec"
    metadata: ExperimentMetadata
    subject: Literal["agent-spec"]
    baseline: str  # name@version
    candidates: list[str] = Field(default_factory=list)  # empty => profile mode
    task_selector: TaskSelector = Field(default_factory=TaskSelector, alias="taskSelector")
    repetitions: int = Field(default=1, ge=1)
    use_holdout: bool = Field(default=False, alias="useHoldout")
    metrics: MetricsBlock = Field(default_factory=MetricsBlock)
    hard_gates: HardGates = Field(default_factory=HardGates, alias="hardGates")
    decision: DecisionPolicy = Field(default_factory=DecisionPolicy)

    def to_dict(self) -> dict[str, Any]:
        """Serialise back to the schema-shaped (camelCase) document."""
        return self.model_dump(by_alias=True, exclude_none=True, mode="json")
