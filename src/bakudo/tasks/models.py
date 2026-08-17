"""Typed contracts for benchmark tasks and immutable task provenance."""

from __future__ import annotations

from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class Family(str, Enum):
    debugging = "debugging"
    no_change = "no-change"
    adversarial_context = "adversarial-context"
    safety = "safety"


class Partition(str, Enum):
    dev = "dev"
    validation = "validation"
    holdout = "holdout"


class Provenance(_Strict):
    created_by: str = Field(alias="createdBy")
    created_at: str = Field(alias="createdAt")
    source_type: str = Field(alias="sourceType")
    eligible_for_promotion: bool = Field(alias="eligibleForPromotion")


class TaskMetadata(_Strict):
    name: str
    version: int = Field(ge=1)
    family: Family
    difficulty: str
    tags: list[str]
    partition: Partition
    paired_task: str | None = Field(default=None, alias="pairedTask")
    canary: str
    provenance: Provenance


class TaskInstruction(_Strict):
    """The observation initially presented to the policy."""

    type: Literal[
        "explore",
        "add-feature",
        "qa",
        "critic",
        "eval-author",
        "skill-gen",
        "maintenance",
        "optimize",
    ]
    title: str
    description: str
    success_criteria: list[str] = Field(alias="successCriteria")


class EnvironmentSpec(_Strict):
    """The execution environment in which state transitions occur."""

    profile: str
    network: Literal["none", "scoped"]


class ResourceLimits(_Strict):
    """Episode limits, intersected with the policy's limits using ``min``."""

    wall_seconds: int | None = Field(default=None, alias="wallSeconds", ge=1)
    tool_calls: int | None = Field(default=None, alias="toolCalls", ge=1)
    tokens: int | None = Field(default=None, ge=1)


class VerifierSpec(_Strict):
    """Privileged reward-evaluation inputs, never exposed to the policy."""

    fail_to_pass: list[str] = Field(alias="failToPass")
    pass_to_pass: list[str] = Field(alias="passToPass")
    command: str
    negative_controls: list[str] = Field(alias="negativeControls")


class ConstraintSpec(_Strict):
    """Hard validity constraints, evaluated separately from reward."""

    expected_status: str = Field(alias="expectedStatus")
    allowed_change_paths: list[str] = Field(alias="allowedChangePaths")
    max_changed_files: int = Field(alias="maxChangedFiles", ge=0)
    forbids_denied_actions: bool = Field(alias="forbidsDeniedActions")
    verifier_inputs_immutable: bool = Field(alias="verifierInputsImmutable")


class TaskSpec(_Strict):
    """A versioned task definition for the code-change environment."""

    api_version: str = Field(default="bakudo.ai/v1alpha1", alias="apiVersion")
    kind: Literal["TaskSpec"] = "TaskSpec"
    metadata: TaskMetadata
    instruction: TaskInstruction
    environment: EnvironmentSpec
    limits: ResourceLimits
    verifier: VerifierSpec
    constraints: ConstraintSpec

    @property
    def ref(self) -> str:
        return f"{self.metadata.name}@{self.metadata.version}"

    def to_dict(self) -> dict[str, Any]:
        return self.model_dump(by_alias=True, exclude_none=True, mode="json")


class TaskPin(_Strict):
    """Immutable identity of the exact task artifact used by a trial."""

    source_uri: str
    corpus_revision: str
    name: str
    version: int = Field(ge=1)
    bundle_digest: str
    verifier_digest: str

    @property
    def ref(self) -> str:
        return f"{self.name}@{self.version}"
