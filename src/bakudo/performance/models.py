"""Pure, frozen contracts for workload measurement and diagnostic evidence.

The models in this module deliberately perform no I/O.  They are the typed
boundary shared by workload sources, sandbox runners, persistence, and the
experiment layer.  JSON uses camelCase while Python callers use snake_case.
"""

from __future__ import annotations

import json
import math
from datetime import UTC, datetime
from enum import Enum
from typing import Annotated, Any, Literal

from pydantic import (
    AwareDatetime,
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    WithJsonSchema,
    field_validator,
    model_validator,
)

from ..ids import (
    new_comparison_id,
    new_measurement_id,
    new_regression_id,
    new_snapshot_id,
)

API_VERSION = "bakudo.ai/v1alpha1"
RECORD_SCHEMA_VERSION = "1"
MAX_SAMPLE_COUNT = 10_000
MAX_EXTENSION_ENTRIES = 64

Digest = Annotated[str, StringConstraints(pattern=r"^sha256:[0-9a-f]{64}$")]
SemanticVersion = Annotated[
    str,
    StringConstraints(pattern=r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$")
]
MetricName = Annotated[str, StringConstraints(pattern=r"^[a-z][a-z0-9_]{0,63}$")]
RelativePath = Annotated[
    str,
    StringConstraints(pattern=r"^[A-Za-z0-9_][A-Za-z0-9_.-]*(/[A-Za-z0-9_][A-Za-z0-9_.-]*)*$"),
]
AwareTimestamp = Annotated[
    AwareDatetime,
    WithJsonSchema(
        {
            "type": "string",
            "format": "date-time",
            "pattern": r"(?:Z|[+-][0-9]{2}:[0-9]{2})$",
        }
    ),
]


class _StrictFrozen(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    def to_dict(self) -> dict[str, Any]:
        return self.model_dump(by_alias=True, exclude_none=True, mode="json")


def canonical_json_bytes(value: BaseModel | dict[str, Any]) -> bytes:
    """Return the single canonical JSON representation used for digests."""

    document = (
        value.model_dump(by_alias=True, exclude_none=True, mode="json")
        if isinstance(value, BaseModel)
        else value
    )
    return json.dumps(
        document,
        ensure_ascii=False,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def canonical_digest(value: BaseModel | dict[str, Any]) -> str:
    import hashlib

    return f"sha256:{hashlib.sha256(canonical_json_bytes(value)).hexdigest()}"


def _relative_path(value: str) -> str:
    from pathlib import PurePosixPath

    if not value or "\\" in value:
        raise ValueError("must be a non-empty POSIX relative path")
    path = PurePosixPath(value)
    if path.is_absolute() or ".." in path.parts or "." in path.parts:
        raise ValueError("must remain below the workload root")
    normalized = path.as_posix()
    if normalized != value:
        raise ValueError("must be a normalized POSIX relative path")
    return value


class MetricDirection(str, Enum):
    lower_is_better = "lower"
    higher_is_better = "higher"


class MetricEstimator(str, Enum):
    median = "median"
    mean = "mean"
    p95 = "p95"
    p99 = "p99"


class MetricSource(str, Enum):
    wall_clock = "wall-clock"
    process = "process"
    workload = "workload"


class MetricUnit(str, Enum):
    seconds = "seconds"
    milliseconds = "milliseconds"
    microseconds = "microseconds"
    nanoseconds = "nanoseconds"
    bytes = "bytes"
    count_unit = "count"
    percent = "percent"
    operations_per_second = "operations/second"
    requests_per_second = "requests/second"


class MeasurementSchedule(str, Enum):
    randomized_pairs = "randomized-pairs"
    abba = "abba"
    fixed = "fixed"


class InvocationPhase(str, Enum):
    warmup = "warmup"
    measured = "measured"


class RecordStatus(str, Enum):
    completed = "completed"
    inconclusive = "inconclusive"
    unsupported = "unsupported"
    invalid_workload = "invalid-workload"
    incompatible_environment = "incompatible-environment"
    timed_out = "timed-out"
    failed = "failed"
    cancelled = "cancelled"


class FailureReason(str, Enum):
    infrastructure = "infrastructure"
    workload = "workload"
    adapter = "adapter"
    normalization = "normalization"
    persistence = "persistence"
    timeout = "timeout"
    cancelled = "cancelled"
    invalid_sample = "invalid-sample"
    integrity = "integrity"
    incompatible_pins = "incompatible-pins"
    unsupported = "unsupported"


class Verdict(str, Enum):
    improved = "improved"
    regressed = "regressed"
    equivalent = "equivalent"
    inconclusive = "inconclusive"


class HotspotKind(str, Enum):
    function = "function"
    call_stack = "call-stack"
    endpoint = "endpoint"
    query = "query"
    allocation = "allocation"
    lock = "lock"
    io = "io"
    resource = "resource"


class SourceKind(str, Enum):
    directory = "directory"
    repository = "repository"
    bundle = "bundle"


class NetworkPolicy(str, Enum):
    none = "none"
    scoped = "scoped"


class WorkloadMetadata(_StrictFrozen):
    name: Annotated[str, StringConstraints(pattern=r"^[a-z][a-z0-9-]{0,62}$")]
    version: SemanticVersion
    description: Annotated[str, StringConstraints(max_length=2_000)] = ""
    labels: dict[
        Annotated[str, StringConstraints(pattern=r"^[a-z][a-z0-9_.-]{0,63}$")],
        Annotated[str, StringConstraints(min_length=1, max_length=128)],
    ] = Field(default_factory=dict, max_length=32)


class WorkloadRef(_StrictFrozen):
    name: Annotated[str, StringConstraints(pattern=r"^[a-z][a-z0-9-]{0,62}$")]
    version: SemanticVersion
    source: SourceKind

    @property
    def ref(self) -> str:
        return f"{self.name}@{self.version}"


class WorkloadCommand(_StrictFrozen):
    argv: tuple[Annotated[str, StringConstraints(min_length=1, max_length=4_096)], ...] = Field(
        min_length=1, max_length=128
    )
    cwd: str = "."
    env: dict[
        Annotated[str, StringConstraints(pattern=r"^[A-Z_][A-Z0-9_]{0,127}$")],
        Annotated[str, StringConstraints(max_length=4_096)],
    ] = Field(default_factory=dict, max_length=64)

    @field_validator("cwd")
    @classmethod
    def validate_cwd(cls, value: str) -> str:
        if value == ".":
            return value
        return _relative_path(value)


class DatasetSpec(_StrictFrozen):
    path: RelativePath
    digest: Digest

    _validate_path = field_validator("path")(_relative_path)


class WorkloadEnvironment(_StrictFrozen):
    profile: Annotated[str, StringConstraints(min_length=1, max_length=128)]
    network: NetworkPolicy = NetworkPolicy.none
    cpu_count: int | None = Field(default=None, alias="cpuCount", ge=1, le=256)
    memory_mb: int | None = Field(default=None, alias="memoryMb", ge=16, le=1_048_576)


class WorkloadSubject(_StrictFrozen):
    repo: Annotated[str, StringConstraints(min_length=1, max_length=256)]


class MetricDefinition(_StrictFrozen):
    name: MetricName
    unit: MetricUnit
    direction: MetricDirection
    source: MetricSource
    estimator: MetricEstimator = MetricEstimator.median
    practical_threshold: float = Field(default=0.0, alias="practicalThreshold", ge=0.0)
    required: bool = True
    minimum_samples: int = Field(default=1, alias="minimumSamples", ge=1, le=MAX_SAMPLE_COUNT)

    @field_validator("practical_threshold")
    @classmethod
    def finite_threshold(cls, value: float) -> float:
        if not math.isfinite(value):
            raise ValueError("must be finite")
        return value


class MeasurementPlan(_StrictFrozen):
    warmups: int = Field(default=0, ge=0, le=1_000)
    repetitions: int = Field(ge=1, le=MAX_SAMPLE_COUNT)
    timeout_seconds: float = Field(alias="timeoutSeconds", gt=0, le=86_400)
    schedule: MeasurementSchedule = MeasurementSchedule.randomized_pairs
    metrics: tuple[MetricDefinition, ...] = Field(min_length=1, max_length=64)

    @model_validator(mode="after")
    def unique_metrics(self) -> MeasurementPlan:
        names = [metric.name for metric in self.metrics]
        if len(names) != len(set(names)):
            raise ValueError("measurement metrics must have unique names")
        return self


ExtensionValue = str | int | float | bool | None
ExtensionKey = Annotated[
    str,
    StringConstraints(pattern=r"^[a-z][a-z0-9-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)+$"),
]


class ProfilerSpec(_StrictFrozen):
    name: Annotated[str, StringConstraints(pattern=r"^[a-z][a-z0-9-]{0,62}$")]
    adapter: Annotated[str, StringConstraints(pattern=r"^[a-z][a-z0-9_.-]{0,127}$")]
    signals: tuple[Annotated[str, StringConstraints(min_length=1, max_length=128)], ...] = Field(
        min_length=1, max_length=32
    )
    options: dict[
        Annotated[str, StringConstraints(pattern=r"^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$")],
        ExtensionValue,
    ] = Field(default_factory=dict, max_length=MAX_EXTENSION_ENTRIES)

    @field_validator("options")
    @classmethod
    def finite_options(cls, values: dict[str, ExtensionValue]) -> dict[str, ExtensionValue]:
        if any(isinstance(value, float) and not math.isfinite(value) for value in values.values()):
            raise ValueError("profiler options must contain only finite numbers")
        return values


class WorkloadSpec(_StrictFrozen):
    api_version: Literal["bakudo.ai/v1alpha1"] = Field(
        "bakudo.ai/v1alpha1", alias="apiVersion"
    )
    kind: Literal["WorkloadSpec"] = "WorkloadSpec"
    metadata: WorkloadMetadata
    subject: WorkloadSubject
    command: WorkloadCommand
    dataset: DatasetSpec | None = None
    environment: WorkloadEnvironment
    measurement: MeasurementPlan
    profilers: tuple[ProfilerSpec, ...] = Field(default_factory=tuple, max_length=16)

    @property
    def ref(self) -> str:
        return f"{self.metadata.name}@{self.metadata.version}"

    @model_validator(mode="after")
    def unique_profilers(self) -> WorkloadSpec:
        names = [profiler.name for profiler in self.profilers]
        if len(names) != len(set(names)):
            raise ValueError("profilers must have unique names")
        return self


class MetricValue(_StrictFrozen):
    name: MetricName
    unit: MetricUnit
    value: float

    @field_validator("value")
    @classmethod
    def finite_value(cls, value: float) -> float:
        if not math.isfinite(value):
            raise ValueError("must be finite")
        return value


class InvocationOutcome(_StrictFrozen):
    ordinal: int = Field(ge=0)
    phase: InvocationPhase
    status: RecordStatus
    elapsed_seconds: float | None = Field(default=None, alias="elapsedSeconds", ge=0)
    exit_code: int | None = Field(default=None, alias="exitCode")
    metrics: tuple[MetricValue, ...] = Field(default_factory=tuple, max_length=64)
    failure_reason: FailureReason | None = Field(default=None, alias="failureReason")
    # Bounded diagnostic tail (runner/guest stderr) for failed invocations;
    # never populated for completed ones.
    failure_detail: str | None = Field(default=None, alias="failureDetail", max_length=2_000)

    @field_validator("elapsed_seconds")
    @classmethod
    def finite_elapsed(cls, value: float | None) -> float | None:
        if value is not None and not math.isfinite(value):
            raise ValueError("must be finite")
        return value

    @model_validator(mode="after")
    def unique_metric_values(self) -> InvocationOutcome:
        names = [metric.name for metric in self.metrics]
        if len(names) != len(set(names)):
            raise ValueError("invocation metrics must have unique names")
        return self


class MetricSampleSet(_StrictFrozen):
    metric_name: MetricName = Field(alias="metricName")
    unit: MetricUnit
    direction: MetricDirection
    estimator: MetricEstimator
    samples: tuple[float, ...] = Field(default_factory=tuple, max_length=MAX_SAMPLE_COUNT)
    invalid_sample_count: int = Field(
        default=0, alias="invalidSampleCount", ge=0, le=MAX_SAMPLE_COUNT
    )
    summary: float | None = None
    dispersion: float | None = Field(default=None, ge=0)
    valid: bool
    invalid_reasons: tuple[Annotated[str, StringConstraints(max_length=512)], ...] = Field(
        default_factory=tuple, alias="invalidReasons", max_length=128
    )

    @field_validator("samples")
    @classmethod
    def finite_samples(cls, values: tuple[float, ...]) -> tuple[float, ...]:
        if any(not math.isfinite(value) for value in values):
            raise ValueError("samples must be finite")
        return values

    @field_validator("summary", "dispersion")
    @classmethod
    def finite_optional(cls, value: float | None) -> float | None:
        if value is not None and not math.isfinite(value):
            raise ValueError("must be finite")
        return value

    @model_validator(mode="after")
    def validate_validity(self) -> MetricSampleSet:
        if self.valid and (not self.samples or self.summary is None):
            raise ValueError("valid sample sets require samples and a summary")
        if not self.valid and not self.invalid_reasons:
            raise ValueError("invalid sample sets require at least one invalid reason")
        return self


class IntegrityResult(_StrictFrozen):
    valid: bool = True
    violations: tuple[Annotated[str, StringConstraints(min_length=1, max_length=256)], ...] = (
        ()
    )
    details: dict[str, Annotated[str, StringConstraints(max_length=1_024)]] = Field(
        default_factory=dict, max_length=64
    )

    @model_validator(mode="after")
    def violations_match_validity(self) -> IntegrityResult:
        if self.valid and self.violations:
            raise ValueError("valid integrity results cannot contain violations")
        if not self.valid and not self.violations:
            raise ValueError("invalid integrity results require at least one violation")
        return self


# Pin models are defined in their own module to make compatibility dependencies
# explicit, then re-exported here for ergonomic record construction.
from .pins import EnvironmentPin, RevisionPin, WorkloadPin  # noqa: E402


class MeasurementRecord(_StrictFrozen):
    schema_version: Literal["1"] = Field("1", alias="schemaVersion")
    kind: Literal["MeasurementRecord"] = "MeasurementRecord"
    id: Annotated[str, StringConstraints(pattern=r"^measurement_[0-9A-HJKMNP-TV-Z]{26}$")] = Field(
        default_factory=new_measurement_id
    )
    created_at: AwareTimestamp = Field(
        default_factory=lambda: datetime.now(UTC), alias="createdAt"
    )
    started_at: AwareTimestamp | None = Field(default=None, alias="startedAt")
    completed_at: AwareTimestamp | None = Field(default=None, alias="completedAt")
    workload: WorkloadPin
    revision: RevisionPin
    environment: EnvironmentPin
    plan_digest: Digest = Field(alias="planDigest")
    warmups: tuple[InvocationOutcome, ...] = Field(default_factory=tuple, max_length=1_000)
    invocations: tuple[InvocationOutcome, ...] = Field(
        default_factory=tuple, max_length=MAX_SAMPLE_COUNT
    )
    metrics: tuple[MetricSampleSet, ...] = Field(default_factory=tuple, max_length=64)
    status: RecordStatus
    integrity: IntegrityResult = Field(default_factory=IntegrityResult)
    exit_code: int | None = Field(default=None, alias="exitCode")
    stdout: Annotated[str, StringConstraints(max_length=65_536)] = ""
    stderr: Annotated[str, StringConstraints(max_length=65_536)] = ""
    failure_reason: FailureReason | None = Field(default=None, alias="failureReason")

    @model_validator(mode="after")
    def validate_record(self) -> MeasurementRecord:
        if any(outcome.phase is not InvocationPhase.warmup for outcome in self.warmups):
            raise ValueError("warmups must contain only warmup invocation outcomes")
        if any(outcome.phase is not InvocationPhase.measured for outcome in self.invocations):
            raise ValueError("invocations must contain only measured outcomes")
        names = [sample.metric_name for sample in self.metrics]
        if len(names) != len(set(names)):
            raise ValueError("metric sample sets must have unique metric names")
        if self.completed_at is not None and self.started_at is not None:
            if self.completed_at < self.started_at:
                raise ValueError("completedAt cannot precede startedAt")
        if self.status is RecordStatus.completed:
            if (
                not self.integrity.valid
                or not self.metrics
                or any(not item.valid for item in self.metrics)
            ):
                raise ValueError("completed records require valid integrity and metric sample sets")
        elif self.failure_reason is None and self.status not in {RecordStatus.inconclusive}:
            raise ValueError("non-completed terminal records require a failureReason")
        return self


class ProfilerDescriptor(_StrictFrozen):
    name: Annotated[str, StringConstraints(min_length=1, max_length=128)]
    adapter: Annotated[str, StringConstraints(min_length=1, max_length=128)]
    version: Annotated[str, StringConstraints(min_length=1, max_length=128)]
    signals: tuple[str, ...] = Field(default_factory=tuple, max_length=32)


class RawProfileArtifact(_StrictFrozen):
    uri: Annotated[str, StringConstraints(min_length=1, max_length=2_048)]
    digest: Digest
    media_type: Annotated[str, StringConstraints(min_length=1, max_length=256)] = Field(
        alias="mediaType"
    )
    byte_size: int = Field(alias="byteSize", ge=0)
    complete: bool = True


class Hotspot(_StrictFrozen):
    kind: HotspotKind
    stable_key: Annotated[str, StringConstraints(min_length=1, max_length=512)] = Field(
        alias="stableKey"
    )
    label: Annotated[str, StringConstraints(min_length=1, max_length=512)]
    source_path: RelativePath | None = Field(default=None, alias="sourcePath")
    source_line: int | None = Field(default=None, alias="sourceLine", ge=1)
    inclusive_cost: float = Field(alias="inclusiveCost", ge=0)
    exclusive_cost: float | None = Field(default=None, alias="exclusiveCost", ge=0)
    sample_count: int = Field(alias="sampleCount", ge=0)
    percentage: float | None = Field(default=None, ge=0, le=100)
    quality: Annotated[str, StringConstraints(min_length=1, max_length=128)] = "resolved"
    extensions: dict[ExtensionKey, ExtensionValue] = Field(default_factory=dict, max_length=64)

    @field_validator("source_path")
    @classmethod
    def validate_source_path(cls, value: str | None) -> str | None:
        return _relative_path(value) if value is not None else None


class PerformanceSnapshot(_StrictFrozen):
    schema_version: Literal["1"] = Field("1", alias="schemaVersion")
    kind: Literal["PerformanceSnapshot"] = "PerformanceSnapshot"
    id: Annotated[str, StringConstraints(pattern=r"^snapshot_[0-9A-HJKMNP-TV-Z]{26}$")] = Field(
        default_factory=new_snapshot_id
    )
    created_at: AwareTimestamp = Field(
        default_factory=lambda: datetime.now(UTC), alias="createdAt"
    )
    workload: WorkloadPin
    revision: RevisionPin
    environment: EnvironmentPin
    profiler_spec_digest: Digest = Field(alias="profilerSpecDigest")
    descriptor: ProfilerDescriptor
    capture_seconds: float = Field(alias="captureSeconds", ge=0)
    observed_overhead: float | None = Field(default=None, alias="observedOverhead", ge=0)
    hotspots: tuple[Hotspot, ...] = Field(default_factory=tuple, max_length=10_000)
    artifacts: tuple[RawProfileArtifact, ...] = Field(default_factory=tuple, max_length=64)
    warnings: tuple[Annotated[str, StringConstraints(max_length=512)], ...] = Field(
        default_factory=tuple, max_length=128
    )
    sanitization_status: Annotated[str, StringConstraints(min_length=1, max_length=128)] = Field(
        alias="sanitizationStatus"
    )
    visibility: Literal["summary", "restricted"] = "restricted"
    status: RecordStatus


class MetricComparison(_StrictFrozen):
    metric_name: MetricName = Field(alias="metricName")
    unit: MetricUnit
    direction: MetricDirection
    estimator: MetricEstimator
    baseline_summary: float | None = Field(alias="baselineSummary")
    candidate_summary: float | None = Field(alias="candidateSummary")
    absolute_effect: float | None = Field(alias="absoluteEffect")
    relative_effect: float | None = Field(alias="relativeEffect")
    ci_lower: float | None = Field(alias="ciLower")
    ci_upper: float | None = Field(alias="ciUpper")
    practical_threshold: float = Field(alias="practicalThreshold", ge=0)
    sample_count: int = Field(alias="sampleCount", ge=0)
    baseline_dispersion: float | None = Field(default=None, alias="baselineDispersion", ge=0)
    candidate_dispersion: float | None = Field(default=None, alias="candidateDispersion", ge=0)
    verdict: Verdict
    valid: bool
    reasons: tuple[str, ...] = Field(default_factory=tuple, max_length=128)

    @field_validator(
        "baseline_summary",
        "candidate_summary",
        "absolute_effect",
        "relative_effect",
        "ci_lower",
        "ci_upper",
        "baseline_dispersion",
        "candidate_dispersion",
    )
    @classmethod
    def finite_comparison_value(cls, value: float | None) -> float | None:
        if value is not None and not math.isfinite(value):
            raise ValueError("must be finite")
        return value


class PerformanceComparison(_StrictFrozen):
    schema_version: Literal["1"] = Field("1", alias="schemaVersion")
    kind: Literal["PerformanceComparison"] = "PerformanceComparison"
    id: Annotated[str, StringConstraints(pattern=r"^comparison_[0-9A-HJKMNP-TV-Z]{26}$")] = Field(
        default_factory=new_comparison_id
    )
    created_at: AwareTimestamp = Field(
        default_factory=lambda: datetime.now(UTC), alias="createdAt"
    )
    workload: WorkloadPin
    baseline_revision: RevisionPin = Field(alias="baselineRevision")
    candidate_revision: RevisionPin = Field(alias="candidateRevision")
    baseline_environment: EnvironmentPin = Field(alias="baselineEnvironment")
    candidate_environment: EnvironmentPin = Field(alias="candidateEnvironment")
    baseline_measurement_id: str = Field(alias="baselineMeasurementId")
    candidate_measurement_id: str = Field(alias="candidateMeasurementId")
    primary_metric: MetricName = Field(alias="primaryMetric")
    metrics: tuple[MetricComparison, ...] = Field(min_length=1, max_length=64)
    status: RecordStatus
    verdict: Verdict
    integrity: IntegrityResult = Field(default_factory=IntegrityResult)
    eligible: bool
    incompatibilities: tuple[str, ...] = Field(default_factory=tuple, max_length=128)
    allowed_differences: tuple[str, ...] = Field(
        default_factory=tuple, alias="allowedDifferences", max_length=128
    )
    analysis_seed: int = Field(alias="analysisSeed")
    confidence: float = Field(gt=0, lt=1)
    bootstrap_resamples: int = Field(alias="bootstrapResamples", ge=1, le=1_000_000)

    @model_validator(mode="after")
    def validate_comparison(self) -> PerformanceComparison:
        names = [metric.metric_name for metric in self.metrics]
        if len(names) != len(set(names)):
            raise ValueError("comparison metrics must have unique names")
        if self.primary_metric not in names:
            raise ValueError("primaryMetric must identify one comparison metric")
        if self.eligible and (
            self.status is not RecordStatus.completed
            or self.verdict is not Verdict.improved
            or not self.integrity.valid
            or self.incompatibilities
        ):
            raise ValueError(
                "eligible comparisons must be completed, improved, integral, and compatible"
            )
        return self


class PerformanceRegressionSignal(_StrictFrozen):
    schema_version: Literal["1"] = Field("1", alias="schemaVersion")
    kind: Literal["PerformanceRegressionSignal"] = "PerformanceRegressionSignal"
    id: Annotated[str, StringConstraints(pattern=r"^regression_[0-9A-HJKMNP-TV-Z]{26}$")] = Field(
        default_factory=new_regression_id
    )
    created_at: AwareTimestamp = Field(
        default_factory=lambda: datetime.now(UTC), alias="createdAt"
    )
    repository: str
    workload: WorkloadPin
    metric_name: MetricName = Field(alias="metricName")
    comparison_id: str = Field(alias="comparisonId")
    relative_regression: float = Field(alias="relativeRegression", gt=0)
    confidence: float = Field(ge=0, le=1)
    consecutive_observations: int = Field(alias="consecutiveObservations", ge=1)
    deduplication_key: Annotated[str, StringConstraints(min_length=1, max_length=512)] = Field(
        alias="deduplicationKey"
    )
    top_hotspot_key: str | None = Field(default=None, alias="topHotspotKey")
    approved: bool = False
