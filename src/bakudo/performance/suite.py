"""Declarative, fail-closed performance scenario suites.

A suite resolves immutable workloads and their metric policy before an operator
starts measurements.  It does not execute code, store results, or convert
diagnostic profiler output into evidence.
"""

from __future__ import annotations

from pathlib import Path
from typing import Annotated, Literal

import yaml
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

from ..schema import validate_performance_suite_spec
from .models import MetricName, SemanticVersion, WorkloadRef
from .pins import WorkloadPin
from .source import LoadedWorkload, WorkloadSource

ScenarioName = Annotated[str, StringConstraints(pattern=r"^[a-z][a-z0-9-]{0,62}$")]


class _StrictFrozen(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    def to_dict(self) -> dict[str, object]:
        return self.model_dump(by_alias=True, exclude_none=True, mode="json")


class PerformanceSuiteMetadata(_StrictFrozen):
    name: ScenarioName
    version: SemanticVersion
    description: Annotated[str, StringConstraints(max_length=2_000)] = ""


class PerformanceScenarioSpec(_StrictFrozen):
    """Metric policy for one immutable workload reference."""

    name: ScenarioName
    objective: Annotated[str, StringConstraints(min_length=1, max_length=512)]
    workload: WorkloadRef
    primary_metric: MetricName = Field(alias="primaryMetric")
    protected_metrics: tuple[MetricName, ...] = Field(
        default_factory=tuple, alias="protectedMetrics", max_length=32
    )
    minimum_paired_samples: int = Field(default=20, alias="minimumPairedSamples", ge=2, le=10_000)
    profiler_on_regression: str | None = Field(
        default=None,
        alias="profilerOnRegression",
        min_length=1,
        max_length=128,
    )
    required: bool = True

    @model_validator(mode="after")
    def unique_metric_policy(self) -> PerformanceScenarioSpec:
        if len(self.protected_metrics) != len(set(self.protected_metrics)):
            raise ValueError("protectedMetrics must not contain duplicates")
        if self.primary_metric in self.protected_metrics:
            raise ValueError("primaryMetric cannot also be a protected metric")
        return self


class PerformanceSuiteSpec(_StrictFrozen):
    api_version: Literal["bakudo.ai/v1alpha1"] = Field("bakudo.ai/v1alpha1", alias="apiVersion")
    kind: Literal["PerformanceSuiteSpec"] = "PerformanceSuiteSpec"
    metadata: PerformanceSuiteMetadata
    confidence: float = Field(default=0.95, gt=0, lt=1)
    bootstrap_resamples: int = Field(default=10_000, alias="bootstrapResamples", ge=1, le=1_000_000)
    scenarios: tuple[PerformanceScenarioSpec, ...] = Field(min_length=1, max_length=128)

    @property
    def ref(self) -> str:
        return f"{self.metadata.name}@{self.metadata.version}"

    @model_validator(mode="after")
    def unique_scenarios(self) -> PerformanceSuiteSpec:
        names = [scenario.name for scenario in self.scenarios]
        if len(names) != len(set(names)):
            raise ValueError("scenarios must have unique names")
        return self


class ResolvedPerformanceScenario(_StrictFrozen):
    name: ScenarioName
    workload: WorkloadPin
    primary_metric: MetricName = Field(alias="primaryMetric")
    protected_metrics: tuple[MetricName, ...] = Field(alias="protectedMetrics")
    minimum_paired_samples: int = Field(alias="minimumPairedSamples", ge=2)
    profiler_on_regression: str | None = Field(default=None, alias="profilerOnRegression")
    required: bool


class PerformanceSuiteResolution(_StrictFrozen):
    suite_ref: str = Field(alias="suiteRef")
    scenarios: tuple[ResolvedPerformanceScenario, ...] = Field(min_length=1, max_length=128)


class PerformanceSuiteLoadError(ValueError):
    """Raised when a suite manifest is invalid or cannot resolve its workloads."""


def load_performance_suite(path: Path) -> PerformanceSuiteSpec:
    """Load a schema-validated declarative suite manifest from YAML."""

    try:
        document = yaml.safe_load(path.read_text())
        validate_performance_suite_spec(document)
        return PerformanceSuiteSpec.model_validate(document)
    except OSError as exc:
        raise PerformanceSuiteLoadError(f"{path}: {exc}") from exc
    except yaml.YAMLError as exc:
        raise PerformanceSuiteLoadError(f"{path}: invalid YAML: {exc}") from exc
    except Exception as exc:
        raise PerformanceSuiteLoadError(f"{path}: {exc}") from exc


def _resolve_scenario(
    scenario: PerformanceScenarioSpec, source: WorkloadSource
) -> ResolvedPerformanceScenario:
    workload: LoadedWorkload = source.load(scenario.workload.ref)
    if workload.pin.source_kind != scenario.workload.source.value:
        raise PerformanceSuiteLoadError(
            f"{scenario.name}: workload source kind {workload.pin.source_kind!r} does not match "
            f"suite reference {scenario.workload.source.value!r}"
        )
    definitions = {metric.name: metric for metric in workload.spec.measurement.metrics}
    required_metrics = (scenario.primary_metric, *scenario.protected_metrics)
    missing = sorted(set(required_metrics) - set(definitions))
    if missing:
        raise PerformanceSuiteLoadError(
            f"{scenario.name}: workload {workload.ref} lacks metrics: {', '.join(missing)}"
        )
    if scenario.minimum_paired_samples > workload.spec.measurement.repetitions:
        raise PerformanceSuiteLoadError(
            f"{scenario.name}: minimumPairedSamples {scenario.minimum_paired_samples} exceeds "
            f"workload repetitions {workload.spec.measurement.repetitions}"
        )
    if scenario.profiler_on_regression is not None:
        profilers = {profiler.name for profiler in workload.spec.profilers}
        if scenario.profiler_on_regression not in profilers:
            raise PerformanceSuiteLoadError(
                f"{scenario.name}: workload {workload.ref} does not declare profiler "
                f"{scenario.profiler_on_regression!r}"
            )
    return ResolvedPerformanceScenario(
        name=scenario.name,
        workload=workload.pin,
        primary_metric=scenario.primary_metric,
        protected_metrics=scenario.protected_metrics,
        minimum_paired_samples=scenario.minimum_paired_samples,
        profiler_on_regression=scenario.profiler_on_regression,
        required=scenario.required,
    )


def resolve_performance_suite(
    suite: PerformanceSuiteSpec, source: WorkloadSource
) -> PerformanceSuiteResolution:
    """Resolve every scenario against immutable workload pins or fail closed."""

    resolved: list[ResolvedPerformanceScenario] = []
    failures: list[str] = []
    for scenario in suite.scenarios:
        try:
            resolved.append(_resolve_scenario(scenario, source))
        except (KeyError, PerformanceSuiteLoadError, ValueError) as exc:
            failures.append(str(exc))
    if failures:
        raise PerformanceSuiteLoadError("suite resolution failed:\n- " + "\n- ".join(failures))
    return PerformanceSuiteResolution(suite_ref=suite.ref, scenarios=tuple(resolved))
