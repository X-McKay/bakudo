"""Append-only provenance for restricted benchmark evaluation exposure.

An exposure record audits *access* to validation or holdout benchmark task
identities. It deliberately contains neither task content nor execution,
verifier, reward, or promotion evidence. A ``TrialRecord`` remains the
evidence for an agent episode; this record answers the separate question of
which restricted benchmark partition was accessed, by whom, and for what
pre-registered evaluation stage.
"""

from __future__ import annotations

from collections.abc import Iterable
from datetime import UTC, datetime
from enum import Enum
from typing import Annotated, Any, Literal, Protocol

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, StringConstraints, model_validator

from ..ids import new_id
from ..tasks.models import TaskPin

_NonEmptyString = Annotated[str, StringConstraints(min_length=1, max_length=2_048)]
_AgentRef = Annotated[str, StringConstraints(min_length=1, max_length=256)]
_ExposureId = Annotated[str, StringConstraints(pattern=r"^exposure_[0-9A-HJKMNP-TV-Z]{26}$")]


class _StrictFrozen(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    def to_dict(self) -> dict[str, Any]:
        return self.model_dump(by_alias=True, exclude_none=True, mode="json")


class RestrictedPartition(str, Enum):
    """Only partitions whose task identities require controlled access."""

    validation = "validation"
    holdout = "holdout"


class ExposurePurpose(str, Enum):
    """Permitted stages for restricted benchmark access."""

    validation_selection = "validation-selection"
    holdout_confirmation = "holdout-confirmation"


class ExposureCorpusPin(_StrictFrozen):
    """The immutable corpus source and revision exposed to an evaluation."""

    source_uri: _NonEmptyString = Field(alias="sourceURI")
    revision: _NonEmptyString


class ExposureTaskPin(_StrictFrozen):
    """A frozen, content-free snapshot of the task identity exposed."""

    source_uri: _NonEmptyString = Field(alias="sourceURI")
    corpus_revision: _NonEmptyString = Field(alias="corpusRevision")
    name: _NonEmptyString
    version: int = Field(ge=1)
    bundle_digest: _NonEmptyString = Field(alias="bundleDigest")
    verifier_digest: _NonEmptyString = Field(alias="verifierDigest")
    partition: RestrictedPartition

    @property
    def ref(self) -> str:
        return f"{self.name}@{self.version}"

    @classmethod
    def from_task_pin(cls, task_pin: TaskPin, *, partition: RestrictedPartition) -> ExposureTaskPin:
        """Freeze a normal task provenance pin for restricted-access audit."""
        return cls(
            source_uri=task_pin.source_uri,
            corpus_revision=task_pin.corpus_revision,
            name=task_pin.name,
            version=task_pin.version,
            bundle_digest=task_pin.bundle_digest,
            verifier_digest=task_pin.verifier_digest,
            partition=partition,
        )


class EvaluationExposureRecord(_StrictFrozen):
    """One append-only restricted benchmark access event.

    Validation permits candidate selection; holdout permits exactly one
    pre-registered candidate confirmation. ``visibility`` is intentionally a
    constant rather than a caller preference, preventing this contract from
    being used as a public-calibration record.
    """

    api_version: Literal["bakudo.ai/v1alpha1"] = Field(
        default="bakudo.ai/v1alpha1", alias="apiVersion"
    )
    kind: Literal["EvaluationExposureRecord"] = "EvaluationExposureRecord"
    schema_version: Literal["1"] = Field(default="1", alias="schemaVersion")
    id: _ExposureId = Field(default_factory=lambda: new_id("exposure"))
    experiment_id: _NonEmptyString = Field(alias="experimentId")
    partition: RestrictedPartition
    purpose: ExposurePurpose
    visibility: Literal["restricted"] = "restricted"
    recorded_by: _NonEmptyString = Field(alias="recordedBy")
    authorization_ref: _NonEmptyString = Field(alias="authorizationRef")
    baseline_ref: _AgentRef = Field(alias="baselineRef")
    candidate_refs: tuple[_AgentRef, ...] = Field(
        alias="candidateRefs", min_length=1, max_length=32
    )
    corpus: ExposureCorpusPin
    task_pins: tuple[ExposureTaskPin, ...] = Field(
        alias="taskPins", min_length=1, max_length=10_000
    )
    recorded_at: AwareDatetime = Field(
        default_factory=lambda: datetime.now(UTC), alias="recordedAt"
    )

    @model_validator(mode="after")
    def validate_restricted_access(self) -> EvaluationExposureRecord:
        expected_purpose = {
            RestrictedPartition.validation: ExposurePurpose.validation_selection,
            RestrictedPartition.holdout: ExposurePurpose.holdout_confirmation,
        }[self.partition]
        if self.purpose is not expected_purpose:
            raise ValueError(
                f"{self.partition.value} exposure requires purpose {expected_purpose.value!r}"
            )
        if len(self.candidate_refs) != len(set(self.candidate_refs)):
            raise ValueError("candidateRefs must be unique")
        if self.baseline_ref in self.candidate_refs:
            raise ValueError("baselineRef cannot also be a candidateRef")
        if self.partition is RestrictedPartition.holdout and len(self.candidate_refs) != 1:
            raise ValueError("holdout exposure permits exactly one pre-registered candidate")

        task_refs = [task.ref for task in self.task_pins]
        if len(task_refs) != len(set(task_refs)):
            raise ValueError("taskPins must not contain duplicate task references")
        for task in self.task_pins:
            if task.source_uri != self.corpus.source_uri:
                raise ValueError("every taskPin.sourceURI must match corpus.sourceURI")
            if task.corpus_revision != self.corpus.revision:
                raise ValueError("every taskPin.corpusRevision must match corpus.revision")
            if task.partition is not self.partition:
                raise ValueError("every taskPin.partition must match the exposure partition")
        return self


class ExposureLedger(Protocol):
    """Append-only audit port, intentionally distinct from trial evidence."""

    def record_exposure(self, record: EvaluationExposureRecord) -> None: ...

    def get_exposure(self, exposure_id: str) -> EvaluationExposureRecord | None: ...

    def list_exposures(
        self,
        *,
        experiment_id: str | None = None,
        partition: RestrictedPartition | None = None,
    ) -> list[EvaluationExposureRecord]: ...


class InMemoryExposureLedger:
    """Dependency-free reference implementation with idempotent inserts."""

    def __init__(self) -> None:
        self._records: dict[str, EvaluationExposureRecord] = {}

    def record_exposure(self, record: EvaluationExposureRecord) -> None:
        existing = self._records.get(record.id)
        if existing is None:
            self._records[record.id] = record
            return
        if existing != record:
            raise ValueError(f"exposure id {record.id!r} is already bound to different evidence")

    def get_exposure(self, exposure_id: str) -> EvaluationExposureRecord | None:
        return self._records.get(exposure_id)

    def list_exposures(
        self,
        *,
        experiment_id: str | None = None,
        partition: RestrictedPartition | None = None,
    ) -> list[EvaluationExposureRecord]:
        records: Iterable[EvaluationExposureRecord] = self._records.values()
        if experiment_id is not None:
            records = (record for record in records if record.experiment_id == experiment_id)
        if partition is not None:
            records = (record for record in records if record.partition is partition)
        return sorted(records, key=lambda record: (record.recorded_at, record.id))
