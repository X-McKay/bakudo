"""Synchronous API adapter for durable Temporal performance workflows.

The HTTP layer accepts convenient repository/workload references.  This
adapter resolves them to immutable pins before starting a workflow, so a
queued operation cannot silently measure different bytes later.
"""

from __future__ import annotations

import asyncio
import os
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any, Protocol

from .. import ids
from ..performance.models import WorkloadSpec
from ..performance.pins import EnvironmentPin
from ..performance.revisions import pin_repository_revision
from ..performance.source import (
    WorkloadSource,
    default_workload_source,
    durable_workload_source_location,
    workload_source_from_location,
)
from ..registry.ledger import Ledger
from .client import (
    connect,
    start_performance_capture,
    start_performance_comparison,
    start_performance_measurement,
)
from .shared import (
    PerformanceCaptureInput,
    PerformanceComparisonInput,
    PerformanceMeasurementInput,
)


class MeasurementRequest(Protocol):
    repository: str
    workload: str
    revision: str
    source: str | None
    environment: dict[str, Any]


class CaptureRequest(MeasurementRequest, Protocol):
    profiler: str


class ComparisonRequest(Protocol):
    repository: str
    workload: str
    baseline_revision: str
    candidate_revision: str
    source: str | None
    environment: dict[str, Any]
    primary_metric: str | None
    protected_metrics: list[str]
    confidence: float
    bootstrap_resamples: int
    seed: int


ClientFactory = Callable[[], Awaitable[Any]]


class PerformanceDispatchError(RuntimeError):
    """A request could not be pinned or submitted durably."""


class PerformanceSubmissionError(PerformanceDispatchError):
    """Pinned input could not be handed to Temporal."""


def _source(location: str | None) -> WorkloadSource:
    if location is None:
        return default_workload_source()
    return workload_source_from_location(location)


def _repository(ledger: Ledger, value: str) -> tuple[str, Path]:
    direct = Path(value).expanduser()
    if direct.is_dir():
        path = direct.resolve()
        return path.name, path
    registered = ledger.get_repo(value)
    if registered is not None:
        return registered.name, Path(registered.path).expanduser().resolve()
    root_value = os.environ.get("BAKUDO_REPO_ROOT")
    if root_value:
        candidate = Path(root_value).expanduser().resolve() / value
        if candidate.is_dir():
            return value, candidate
    raise PerformanceDispatchError(
        f"unknown repository {value!r}; pass a checkout path or register it with "
        "`bakudo repo add`"
    )


class TemporalPerformanceDispatcher:
    """Pin API requests and submit them to Temporal without awaiting results."""

    def __init__(
        self,
        ledger: Ledger,
        *,
        client_factory: ClientFactory = connect,
        workload_source_factory: Callable[[str | None], WorkloadSource] = _source,
    ) -> None:
        self._ledger = ledger
        self._client_factory = client_factory
        self._workload_source_factory = workload_source_factory

    def _pins(
        self, request: MeasurementRequest | CaptureRequest | ComparisonRequest
    ) -> tuple[str, Path, WorkloadSpec, str, str, dict[str, Any], EnvironmentPin]:
        repository, path = _repository(self._ledger, request.repository)
        loaded = self._workload_source_factory(request.source).load(request.workload)
        if loaded.spec.subject.repo != repository:
            raise PerformanceDispatchError(
                f"workload subject {loaded.spec.subject.repo!r} does not match "
                f"repository {repository!r}"
            )
        environment = EnvironmentPin.model_validate(request.environment)
        self._ledger.record_workload_version(loaded.spec, loaded.pin)
        return (
            repository,
            path,
            loaded.spec,
            loaded.ref,
            request.source or durable_workload_source_location(loaded),
            loaded.pin.model_dump(by_alias=True, mode="json"),
            environment,
        )

    def _submit(self, starter: Callable[[Any, Any], Awaitable[Any]], inp: Any) -> str:
        async def submit() -> None:
            client = await self._client_factory()
            await starter(client, inp)

        try:
            asyncio.run(submit())
        except PerformanceDispatchError:
            raise
        except Exception as exc:  # noqa: BLE001 - stable adapter boundary
            raise PerformanceSubmissionError(
                f"failed to submit performance workflow to Temporal: {exc}"
            ) from exc
        return str(inp.operation_id)

    def start_measurement(self, request: MeasurementRequest) -> str:
        repository, path, _spec, workload, source, workload_pin, environment = self._pins(
            request
        )
        revision = pin_repository_revision(
            path, request.revision, repository=repository, require_clean=True
        )
        operation_id = ids.new_id("operation")
        inp = PerformanceMeasurementInput(
            operation_id=operation_id,
            workload=workload,
            revision=revision.model_dump(by_alias=True, mode="json"),
            environment=environment.model_dump(by_alias=True, mode="json"),
            workload_source=source,
            workload_pin=workload_pin,
        )
        return self._submit(start_performance_measurement, inp)

    def start_capture(self, request: CaptureRequest) -> str:
        repository, path, spec, workload, source, workload_pin, environment = self._pins(
            request
        )
        if request.profiler not in {profiler.name for profiler in spec.profilers}:
            raise PerformanceDispatchError(
                f"profiler {request.profiler!r} is not declared by workload {workload}"
            )
        revision = pin_repository_revision(
            path, request.revision, repository=repository, require_clean=True
        )
        operation_id = ids.new_id("operation")
        inp = PerformanceCaptureInput(
            operation_id=operation_id,
            workload=workload,
            revision=revision.model_dump(by_alias=True, mode="json"),
            environment=environment.model_dump(by_alias=True, mode="json"),
            profiler=request.profiler,
            workload_source=source,
            workload_pin=workload_pin,
        )
        return self._submit(start_performance_capture, inp)

    def start_comparison(self, request: ComparisonRequest) -> str:
        repository, path, _spec, workload, source, workload_pin, environment = self._pins(
            request
        )
        baseline = pin_repository_revision(
            path,
            request.baseline_revision,
            repository=repository,
            require_clean=True,
        )
        candidate = pin_repository_revision(
            path,
            request.candidate_revision,
            repository=repository,
            require_clean=True,
        )
        operation_id = ids.new_id("operation")
        inp = PerformanceComparisonInput(
            operation_id=operation_id,
            workload=workload,
            baseline_revision=baseline.model_dump(by_alias=True, mode="json"),
            candidate_revision=candidate.model_dump(by_alias=True, mode="json"),
            baseline_environment=environment.model_dump(by_alias=True, mode="json"),
            candidate_environment=environment.model_dump(by_alias=True, mode="json"),
            seed=request.seed,
            workload_source=source,
            workload_pin=workload_pin,
            primary_metric=request.primary_metric,
            protected_metrics=list(request.protected_metrics),
            confidence=request.confidence,
            bootstrap_resamples=request.bootstrap_resamples,
        )
        return self._submit(start_performance_comparison, inp)
