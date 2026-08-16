"""Pydantic models mirroring ``schemas/scenario-spec.schema.json``.

The models give us ergonomic, typed access in Python; the JSON Schema
remains the cross-language source of truth (see
:func:`bakudo.schema.validate_scenario_spec`). A ``ScenarioSpec`` is a
versioned, reproducible, self-contained benchmark unit (experiment
substrate design doc section 5) — the measurement-side counterpart to
:class:`bakudo.agent_spec.models.AgentSpec`.
"""

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


class ScenarioMetadata(_Strict):
    name: str
    version: int = Field(ge=1)
    family: Family
    difficulty: str
    tags: list[str]
    partition: Partition
    twin_of: str | None = Field(default=None, alias="twinOf")
    canary: str
    provenance: Provenance


class Mission(_Strict):
    type: str
    title: str
    description: str
    acceptance_criteria: list[str] = Field(alias="acceptanceCriteria")
    constraints: dict[str, Any]


class ScenarioEnvironment(_Strict):
    profile: str
    network: Literal["none", "scoped"]


class ScenarioBudgets(_Strict):
    """Combined with the agent spec's budget via ``min()`` — tighten-only."""

    wall_seconds: int | None = Field(default=None, alias="wallSeconds", ge=1)
    tool_calls: int | None = Field(default=None, alias="toolCalls", ge=1)
    tokens: int | None = Field(default=None, ge=1)


class Hidden(_Strict):
    """SWE-bench-compatible test semantics; never materialized into the
    agent's workspace."""

    fail_to_pass: list[str] = Field(alias="failToPass")
    pass_to_pass: list[str] = Field(alias="passToPass")
    test_command: str = Field(alias="testCommand")
    wrong_fix_probes: list[str] = Field(alias="wrongFixProbes")
    expected_files: list[str] = Field(alias="expectedFiles")


class ScenarioExpect(_Strict):
    status: str
    changes_paths: list[str] = Field(alias="changesPaths")
    max_changed_files: int = Field(alias="maxChangedFiles", ge=0)
    forbids_denied_commands: bool = Field(alias="forbidsDeniedCommands")
    test_paths_immutable: bool = Field(alias="testPathsImmutable")


class ScenarioSpec(_Strict):
    api_version: str = Field(default="bakudo.ai/v1alpha1", alias="apiVersion")
    kind: str = "ScenarioSpec"
    metadata: ScenarioMetadata
    mission: Mission
    environment: ScenarioEnvironment
    budgets: ScenarioBudgets
    hidden: Hidden
    expect: ScenarioExpect

    @property
    def ref(self) -> str:
        """The canonical ``name@version`` reference, e.g. ``sample-bug@1``."""
        return f"{self.metadata.name}@{self.metadata.version}"

    def to_dict(self) -> dict[str, Any]:
        """Serialise back to the schema-shaped (camelCase) document."""
        return self.model_dump(by_alias=True, exclude_none=True, mode="json")
