from __future__ import annotations

import asyncio
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, replace
from pathlib import Path

import pytest

from bakudo.performance.models import (
    InvocationOutcome,
    InvocationPhase,
    MeasurementRecord,
    MetricValue,
    PerformanceSnapshot,
    ProfilerDescriptor,
    RecordStatus,
    canonical_digest,
)
from bakudo.performance.pins import EnvironmentPin, RevisionPin
from bakudo.performance.profiler import ProfileTimeoutError
from bakudo.performance.revisions import sha256_text
from bakudo.performance.source import DirectoryWorkloadSource, LoadedWorkload
from bakudo.registry.ledger import InMemoryLedger
from bakudo.temporal import _impl
from bakudo.temporal.shared import (
    TASK_QUEUE_RUNS,
    PerformanceCaptureInput,
    PerformanceComparisonInput,
    PerformanceMeasurementInput,
    deterministic_performance_id,
)

_DIGEST = "sha256:" + "a" * 64
_WORKLOAD = "smoke-python-loop@1.0.1"


def _source() -> DirectoryWorkloadSource:
    return DirectoryWorkloadSource(Path(__file__).parents[1] / "smoke" / "workloads")


def _revision(char: str) -> RevisionPin:
    return RevisionPin(
        repository="bakudo-smoke",
        source_uri="file:///tmp/bakudo-smoke",
        commit_sha=char * 40,
        tree_digest="sha256:" + char * 64,
    )


def _environment() -> EnvironmentPin:
    return EnvironmentPin(
        bakudo_version="3.0.0",
        abox_version="0.7.2",
        image_digest=_DIGEST,
        profile="python-glibc",
        hardware_class="test",
        architecture="arm64",
        cpu_count=1,
        memory_mb=256,
        os="linux",
        kernel="test",
        dependency_lock_digest=_DIGEST,
        environment_digest=_DIGEST,
    )


def _document(value: object) -> dict:
    return value.model_dump(by_alias=True, mode="json")  # type: ignore[attr-defined,no-any-return]


@dataclass(frozen=True)
class _Call:
    revision: str
    phase: InvocationPhase
    ordinal: int


class _Invoker:
    def __init__(self, *, timeout_revision: str | None = None) -> None:
        self.calls: list[_Call] = []
        self.timeout_revision = timeout_revision

    def invoke(
        self,
        workload: LoadedWorkload,
        revision: RevisionPin,
        environment: EnvironmentPin,
        *,
        phase: InvocationPhase,
        ordinal: int,
    ) -> InvocationOutcome:
        del environment
        key = revision.commit_sha[0]
        self.calls.append(_Call(key, phase, ordinal))
        if key == self.timeout_revision:
            raise TimeoutError("bounded workload timeout")
        value = 0.0 if phase is InvocationPhase.warmup else (10.0 if key == "a" else 5.0)
        metric = workload.spec.measurement.metrics[0]
        return InvocationOutcome(
            ordinal=ordinal,
            phase=phase,
            status=RecordStatus.completed,
            elapsed_seconds=value,
            exit_code=0,
            metrics=(MetricValue(name=metric.name, unit=metric.unit, value=value),),
        )


class _BlockingInvoker(_Invoker):
    def __init__(self) -> None:
        super().__init__()
        self.started = threading.Event()
        self.release = threading.Event()

    def invoke(
        self,
        workload: LoadedWorkload,
        revision: RevisionPin,
        environment: EnvironmentPin,
        *,
        phase: InvocationPhase,
        ordinal: int,
    ) -> InvocationOutcome:
        if not self.started.is_set():
            self.started.set()
            self.release.wait(timeout=10)
        return super().invoke(
            workload,
            revision,
            environment,
            phase=phase,
            ordinal=ordinal,
        )


class _Capture:
    def __init__(self, *, transient_failures: int = 0) -> None:
        self.calls = 0
        self.transient_failures = transient_failures

    def capture(
        self,
        workload: LoadedWorkload,
        revision: RevisionPin,
        environment: EnvironmentPin,
        profiler: object,
        *,
        snapshot_id: str,
        cancel_event: object | None = None,
    ) -> PerformanceSnapshot:
        del cancel_event
        self.calls += 1
        if self.calls <= self.transient_failures:
            raise RuntimeError("transient capture infrastructure failure")
        return PerformanceSnapshot(
            id=snapshot_id,
            workload=workload.pin,
            revision=revision,
            environment=environment.model_copy(
                update={
                    "profiler_adapter": profiler.adapter,  # type: ignore[attr-defined]
                    "profiler_version": "1",
                }
            ),
            profiler_spec_digest=canonical_digest(profiler),  # type: ignore[arg-type]
            descriptor=ProfilerDescriptor(
                name=profiler.name,  # type: ignore[attr-defined]
                adapter=profiler.adapter,  # type: ignore[attr-defined]
                version="1",
            ),
            capture_seconds=0.25,
            sanitization_status="sanitized",
            status=RecordStatus.completed,
        )


class _TimeoutCapture(_Capture):
    def capture(self, *args: object, **kwargs: object) -> PerformanceSnapshot:
        del args, kwargs
        raise ProfileTimeoutError("profile deadline expired")


class _AmbiguousMeasurementLedger(InMemoryLedger):
    """Simulate a commit that succeeds before the client sees a failure."""

    def __init__(self) -> None:
        super().__init__()
        self.fail_after_first_commit = True

    def record_measurement(self, record: MeasurementRecord) -> None:
        super().record_measurement(record)
        if self.fail_after_first_commit:
            self.fail_after_first_commit = False
            raise RuntimeError("connection lost after commit")


@pytest.fixture
def performance_deps(monkeypatch: pytest.MonkeyPatch) -> _impl.Deps:
    monkeypatch.delenv("BAKUDO_SANDBOX", raising=False)
    deps = _impl.Deps(
        ledger=InMemoryLedger(),
        performance_workload_source_fn=_source,
    )
    monkeypatch.setattr(_impl, "DEPS", deps)
    return deps


def _measurement_input(operation_id: str = "op-measure") -> PerformanceMeasurementInput:
    return PerformanceMeasurementInput(
        operation_id=operation_id,
        workload=_WORKLOAD,
        revision=_document(_revision("a")),
        environment=_document(_environment()),
        measurement_id=deterministic_performance_id("measurement", operation_id, "measurement"),
    )


def _capture_input(operation_id: str = "op-capture") -> PerformanceCaptureInput:
    return PerformanceCaptureInput(
        operation_id=operation_id,
        workload=_WORKLOAD,
        revision=_document(_revision("a")),
        environment=_document(_environment()),
        profiler="synthetic",
        snapshot_id=deterministic_performance_id("snapshot", operation_id, "capture"),
    )


def _comparison_input(operation_id: str = "op-compare") -> PerformanceComparisonInput:
    return PerformanceComparisonInput(
        operation_id=operation_id,
        workload=_WORKLOAD,
        baseline_revision=_document(_revision("a")),
        candidate_revision=_document(_revision("b")),
        baseline_environment=_document(_environment()),
        candidate_environment=_document(_environment()),
        seed=17,
        bootstrap_resamples=100,
        baseline_measurement_id=deterministic_performance_id(
            "measurement", operation_id, "comparison-baseline"
        ),
        candidate_measurement_id=deterministic_performance_id(
            "measurement", operation_id, "comparison-candidate"
        ),
        comparison_id=deterministic_performance_id("comparison", operation_id, "comparison"),
    )


def test_deterministic_performance_ids_are_stable_and_role_scoped() -> None:
    first = deterministic_performance_id("measurement", "operation-1", "baseline")
    assert first == deterministic_performance_id("measurement", "operation-1", "baseline")
    assert first != deterministic_performance_id("measurement", "operation-1", "candidate")
    assert first.startswith("measurement_") and len(first.removeprefix("measurement_")) == 26


def test_measurement_activity_is_successful_and_idempotent(
    performance_deps: _impl.Deps,
) -> None:
    invoker = _Invoker()
    performance_deps.performance_invoker = invoker
    inp = _measurement_input()

    first = _impl.run_performance_measurement(inp)
    call_count = len(invoker.calls)
    second = _impl.run_performance_measurement(inp)

    assert first.status == second.status == RecordStatus.completed.value
    assert first.record_id == second.record_id == inp.measurement_id
    assert call_count == 7
    assert len(invoker.calls) == call_count


def test_measurement_activity_rejects_workload_pin_mismatch(
    performance_deps: _impl.Deps,
) -> None:
    invoker = _Invoker()
    performance_deps.performance_invoker = invoker
    loaded = _source().load(_WORKLOAD)
    pin = loaded.pin.model_dump(by_alias=True, mode="json")
    pin["bundleDigest"] = "sha256:" + "f" * 64
    inp = replace(
        _measurement_input("op-tampered-workload-pin"),
        workload_source=str(Path(__file__).parents[1] / "smoke" / "workloads"),
        workload_pin=pin,
    )

    result = _impl.run_performance_measurement(inp)

    assert result.status == RecordStatus.invalid_workload.value
    assert "immutable request pin" in (result.reason or "")
    assert invoker.calls == []


def test_measurement_activity_preserves_timeout_and_unsupported_states(
    performance_deps: _impl.Deps,
) -> None:
    performance_deps.performance_invoker = _Invoker(timeout_revision="a")
    timed_out = _impl.run_performance_measurement(_measurement_input("op-timeout"))
    assert timed_out.status == RecordStatus.timed_out.value
    assert timed_out.record is not None

    performance_deps.performance_invoker = None
    unsupported = _impl.run_performance_measurement(_measurement_input("op-unsupported"))
    assert unsupported.status == RecordStatus.unsupported.value
    assert unsupported.record is None


def test_measurement_retry_recovers_an_ambiguous_persistence_commit(
    performance_deps: _impl.Deps,
) -> None:
    ledger = _AmbiguousMeasurementLedger()
    invoker = _Invoker()
    performance_deps.ledger = ledger
    performance_deps.performance_invoker = invoker
    inp = _measurement_input("op-ambiguous-commit")

    with pytest.raises(RuntimeError, match="after commit"):
        _impl.run_performance_measurement(inp)
    call_count = len(invoker.calls)
    recovered = _impl.run_performance_measurement(inp)

    assert recovered.status == RecordStatus.completed.value
    assert recovered.record_id == inp.measurement_id
    assert len(invoker.calls) == call_count
    assert len(ledger.list_measurements()) == 1


def test_comparison_activity_persists_all_evidence_and_is_idempotent(
    performance_deps: _impl.Deps,
) -> None:
    invoker = _Invoker()
    performance_deps.performance_invoker = invoker
    inp = _comparison_input()

    first = _impl.run_performance_comparison(inp)
    call_count = len(invoker.calls)
    second = _impl.run_performance_comparison(inp)

    assert first.status == second.status == RecordStatus.completed.value
    assert first.record_id == second.record_id == inp.comparison_id
    assert set(first.related_records) == {"baseline", "candidate"}
    assert first.record is not None and first.record["verdict"] == "improved"
    assert call_count == 14
    assert len(invoker.calls) == call_count


def test_comparison_activity_returns_inconclusive_when_one_side_times_out(
    performance_deps: _impl.Deps,
) -> None:
    performance_deps.performance_invoker = _Invoker(timeout_revision="b")
    result = _impl.run_performance_comparison(_comparison_input("op-inconclusive"))

    assert result.status == RecordStatus.inconclusive.value
    assert result.related_records["candidate"]["status"] == RecordStatus.timed_out.value


def test_comparison_activity_carries_exact_candidate_patch_identity(
    performance_deps: _impl.Deps,
) -> None:
    patch = "diff --git a/run.py b/run.py\n--- a/run.py\n+++ b/run.py\n"
    candidate = _revision("b").model_copy(
        update={
            "base_commit_sha": _revision("b").commit_sha,
            "patch_digest": sha256_text(patch),
        }
    )
    performance_deps.performance_invoker = _Invoker()
    inp = replace(
        _comparison_input("op-patched-candidate"),
        candidate_revision=_document(candidate),
        candidate_patch=patch,
    )

    result = _impl.run_performance_comparison(inp)

    assert result.status == RecordStatus.completed.value
    assert result.record is not None
    assert result.record["candidateRevision"]["patchDigest"] == sha256_text(patch)


def test_capture_activity_retries_safely_and_then_deduplicates(
    performance_deps: _impl.Deps,
) -> None:
    capture = _Capture(transient_failures=1)
    performance_deps.performance_capture = capture
    inp = _capture_input()

    with pytest.raises(RuntimeError, match="transient capture"):
        _impl.run_performance_capture(inp)
    completed = _impl.run_performance_capture(inp)
    repeated = _impl.run_performance_capture(inp)

    assert completed.status == repeated.status == RecordStatus.completed.value
    assert completed.record_id == repeated.record_id == inp.snapshot_id
    assert capture.calls == 2


def test_capture_activity_preserves_typed_profiler_timeout(
    performance_deps: _impl.Deps,
) -> None:
    performance_deps.performance_capture = _TimeoutCapture()

    result = _impl.run_performance_capture(_capture_input("op-profile-timeout"))

    assert result.status == RecordStatus.timed_out.value
    assert result.record is None


def test_activity_cancellation_short_circuits_without_external_work(
    performance_deps: _impl.Deps,
) -> None:
    invoker = _Invoker()
    capture = _Capture()
    performance_deps.performance_invoker = invoker
    performance_deps.performance_capture = capture
    cancelled = threading.Event()
    cancelled.set()

    measurement = _impl.run_performance_measurement(
        _measurement_input("op-cancel-measure"), cancelled
    )
    comparison = _impl.run_performance_comparison(_comparison_input("op-cancel-compare"), cancelled)
    profile = _impl.run_performance_capture(_capture_input("op-cancel-capture"), cancelled)

    assert {measurement.status, comparison.status, profile.status} == {RecordStatus.cancelled.value}
    assert invoker.calls == []
    assert capture.calls == 0


def test_worker_registers_performance_workflows_and_activities() -> None:
    from bakudo.temporal.activities import ALL_ACTIVITIES
    from bakudo.temporal.worker import worker_configs
    from bakudo.temporal.workflows import (
        PerformanceCaptureWorkflow,
        PerformanceComparisonWorkflow,
        PerformanceMeasurementWorkflow,
    )

    configs = {config["task_queue"]: config for config in worker_configs()}
    workflows = configs[TASK_QUEUE_RUNS]["workflows"]
    for workflow_type in (
        PerformanceMeasurementWorkflow,
        PerformanceCaptureWorkflow,
        PerformanceComparisonWorkflow,
    ):
        assert workflow_type in workflows
    activity_names = {activity.__name__ for activity in ALL_ACTIVITIES}
    assert {
        "run_performance_measurement",
        "run_performance_capture",
        "run_performance_comparison",
    } <= activity_names
    for config in configs.values():
        config["activity_executor"].shutdown(wait=False)


@pytest.fixture
async def temporal_environment():
    from temporalio.testing import WorkflowEnvironment

    try:
        environment = await WorkflowEnvironment.start_time_skipping()
    except RuntimeError as exc:
        if "Operation not permitted" in str(exc):
            pytest.skip("Temporal test server cannot bind in this sandbox")
        raise
    yield environment
    await environment.shutdown()


async def test_real_temporal_workflows_resolve_stable_ids(
    temporal_environment: object,
    performance_deps: _impl.Deps,
) -> None:
    from temporalio.worker import Worker

    from bakudo.temporal.activities import ALL_ACTIVITIES
    from bakudo.temporal.workflows import (
        PerformanceCaptureWorkflow,
        PerformanceComparisonWorkflow,
        PerformanceMeasurementWorkflow,
    )

    performance_deps.performance_invoker = _Invoker()
    performance_deps.performance_capture = _Capture()
    worker = Worker(
        temporal_environment.client,  # type: ignore[attr-defined]
        task_queue=TASK_QUEUE_RUNS,
        workflows=[
            PerformanceMeasurementWorkflow,
            PerformanceCaptureWorkflow,
            PerformanceComparisonWorkflow,
        ],
        activities=ALL_ACTIVITIES,
        activity_executor=ThreadPoolExecutor(max_workers=4),
    )
    measurement = _measurement_input("temporal-measure")
    measurement = PerformanceMeasurementInput(
        operation_id=measurement.operation_id,
        workload=measurement.workload,
        revision=measurement.revision,
        environment=measurement.environment,
    )
    capture = _capture_input("temporal-capture")
    capture = PerformanceCaptureInput(
        operation_id=capture.operation_id,
        workload=capture.workload,
        revision=capture.revision,
        environment=capture.environment,
        profiler=capture.profiler,
    )
    comparison = _comparison_input("temporal-compare")
    comparison = PerformanceComparisonInput(
        operation_id=comparison.operation_id,
        workload=comparison.workload,
        baseline_revision=comparison.baseline_revision,
        candidate_revision=comparison.candidate_revision,
        baseline_environment=comparison.baseline_environment,
        candidate_environment=comparison.candidate_environment,
        seed=comparison.seed,
        bootstrap_resamples=100,
    )
    async with worker:
        measured = await temporal_environment.client.execute_workflow(  # type: ignore[attr-defined]
            PerformanceMeasurementWorkflow.run,
            measurement,
            id="test-performance-measurement",
            task_queue=TASK_QUEUE_RUNS,
        )
        captured = await temporal_environment.client.execute_workflow(  # type: ignore[attr-defined]
            PerformanceCaptureWorkflow.run,
            capture,
            id="test-performance-capture",
            task_queue=TASK_QUEUE_RUNS,
        )
        compared = await temporal_environment.client.execute_workflow(  # type: ignore[attr-defined]
            PerformanceComparisonWorkflow.run,
            comparison,
            id="test-performance-comparison",
            task_queue=TASK_QUEUE_RUNS,
        )

    assert measured.record_id == deterministic_performance_id(
        "measurement", measurement.operation_id, "measurement"
    )
    assert captured.record_id == deterministic_performance_id(
        "snapshot", capture.operation_id, "capture"
    )
    assert compared.record_id == deterministic_performance_id(
        "comparison", comparison.operation_id, "comparison"
    )


async def test_measurement_workflow_signal_cancels_blocking_activity(
    temporal_environment: object,
    performance_deps: _impl.Deps,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from temporalio.worker import Worker

    from bakudo.temporal import activities
    from bakudo.temporal.activities import ALL_ACTIVITIES
    from bakudo.temporal.workflows import PerformanceMeasurementWorkflow

    invoker = _BlockingInvoker()
    performance_deps.performance_invoker = invoker
    monkeypatch.setattr(activities, "_HEARTBEAT_INTERVAL_SECONDS", 0.01)
    inp = _measurement_input("temporal-cancel")
    inp = PerformanceMeasurementInput(
        operation_id=inp.operation_id,
        workload=inp.workload,
        revision=inp.revision,
        environment=inp.environment,
    )
    worker = Worker(
        temporal_environment.client,  # type: ignore[attr-defined]
        task_queue=TASK_QUEUE_RUNS,
        workflows=[PerformanceMeasurementWorkflow],
        activities=ALL_ACTIVITIES,
        activity_executor=ThreadPoolExecutor(max_workers=4),
    )
    async with worker:
        handle = await temporal_environment.client.start_workflow(  # type: ignore[attr-defined]
            PerformanceMeasurementWorkflow.run,
            inp,
            id="test-performance-measurement-cancel",
            task_queue=TASK_QUEUE_RUNS,
        )
        assert await asyncio.to_thread(invoker.started.wait, 5)
        await handle.signal(PerformanceMeasurementWorkflow.cancel)
        invoker.release.set()
        result = await handle.result()

    assert result.status == RecordStatus.cancelled.value
