from __future__ import annotations

import sys
from collections.abc import Mapping, Sequence
from pathlib import Path

import pytest
from pydantic import ValidationError

from bakudo.abox.profiler import (
    AboxProfilerRunner,
    ProfileProcessResult,
)
from bakudo.performance.adapters.process import ProcessProfilerAdapter
from bakudo.performance.adapters.python_sampling import PythonSamplingAdapter
from bakudo.performance.adapters.synthetic import SyntheticProfilerAdapter
from bakudo.performance.artifacts import InMemoryArtifactStore
from bakudo.performance.models import (
    EnvironmentPin,
    HotspotKind,
    InvocationOutcome,
    InvocationPhase,
    ProfilerSpec,
    RecordStatus,
    RevisionPin,
    WorkloadPin,
)
from bakudo.performance.normalize import RawHotspot
from bakudo.performance.profiler import (
    CapturedProfile,
    CaptureLimits,
    DiagnosticDuration,
    PreparedCapture,
    ProfileArtifactError,
    ProfileCaptureRequest,
    ProfileTimeoutError,
    WorkloadInvocation,
)

_DIGEST = "sha256:" + "0" * 64


def _workload_pin() -> WorkloadPin:
    return WorkloadPin(
        sourceURI="file:///workload",
        sourceKind="directory",
        collectionRevision="main",
        name="smoke",
        version="1.0.0",
        manifestDigest=_DIGEST,
        bundleDigest=_DIGEST,
    )


def _revision_pin() -> RevisionPin:
    return RevisionPin(
        repository="fixture",
        sourceURI="file:///workspace",
        commitSHA="a" * 40,
        treeDigest=_DIGEST,
    )


def _environment_pin() -> EnvironmentPin:
    return EnvironmentPin(
        bakudoVersion="3.0.0",
        aboxVersion="0.7.1",
        imageDigest=_DIGEST,
        profile="python-small",
        hardwareClass="test",
        architecture="arm64",
        cpuCount=1,
        memoryMb=512,
        os="linux",
        kernel="test",
        dependencyLockDigest=_DIGEST,
        environmentDigest=_DIGEST,
    )


def _request(
    workspace: Path,
    spec: ProfilerSpec,
    invocation: WorkloadInvocation,
    *,
    limits: CaptureLimits | None = None,
) -> ProfileCaptureRequest:
    return ProfileCaptureRequest(
        idempotency_key="capture-1",
        workload=_workload_pin(),
        revision=_revision_pin(),
        environment=_environment_pin(),
        profiler=spec,
        workspace=workspace.resolve(),
        invocation=invocation,
        limits=limits or CaptureLimits(),
    )


def test_synthetic_capture_persists_normalized_snapshot(tmp_path: Path) -> None:
    adapter = SyntheticProfilerAdapter(
        (
            RawHotspot(
                kind=HotspotKind.function,
                label="hot password=do-not-store",
                source_path=tmp_path.as_posix() + "/src/hot.py",
                source_line=4,
                inclusive_cost=8,
                sample_count=10,
            ),
        )
    )
    store = InMemoryArtifactStore()
    seen: list[tuple[str, ...]] = []

    def execute(
        argv: Sequence[str],
        *,
        cwd: Path,
        env: Mapping[str, str],
        timeout: float,
        max_output_chars: int,
    ) -> ProfileProcessResult:
        del cwd, env, timeout, max_output_chars
        seen.append(tuple(argv))
        return ProfileProcessResult(0)

    runner = AboxProfilerRunner(adapter=adapter, artifact_store=store, executor=execute)
    snapshot = runner.capture(
        _request(
            tmp_path,
            ProfilerSpec(
                name="synthetic",
                adapter="bakudo.synthetic",
                signals=("synthetic-hotspots",),
            ),
            WorkloadInvocation(("python", "work.py")),
        )
    )

    assert seen == [("python", "work.py")]
    assert snapshot.kind == "PerformanceSnapshot"
    assert snapshot.status is RecordStatus.completed
    assert snapshot.environment.profiler_adapter == "bakudo.synthetic"
    assert snapshot.hotspots[0].label == "hot password=<redacted>"
    assert snapshot.hotspots[0].source_path == "src/hot.py"
    assert snapshot.artifacts[0].digest.startswith("sha256:")
    assert len(store) == 1


def test_diagnostic_duration_cannot_enter_measurement_elapsed_field() -> None:
    duration = DiagnosticDuration(1.25)

    assert not isinstance(duration, float)
    with pytest.raises(ValidationError):
        InvocationOutcome(
            ordinal=0,
            phase=InvocationPhase.measured,
            status=RecordStatus.completed,
            elapsedSeconds=duration,
        )


def test_runner_rejects_timeout_and_output_escape(tmp_path: Path) -> None:
    adapter = SyntheticProfilerAdapter()
    spec = ProfilerSpec(
        name="synthetic",
        adapter="bakudo.synthetic",
        signals=("synthetic-hotspots",),
    )

    def timeout_executor(
        argv: Sequence[str],
        *,
        cwd: Path,
        env: Mapping[str, str],
        timeout: float,
        max_output_chars: int,
    ) -> ProfileProcessResult:
        del argv, cwd, env, timeout, max_output_chars
        return ProfileProcessResult(124, timed_out=True)

    runner = AboxProfilerRunner(
        adapter=adapter,
        artifact_store=InMemoryArtifactStore(),
        executor=timeout_executor,
    )
    with pytest.raises(ProfileTimeoutError, match="timed out"):
        runner.capture(_request(tmp_path, spec, WorkloadInvocation(("python", "work.py"))))

    def raising_timeout_executor(
        argv: Sequence[str],
        *,
        cwd: Path,
        env: Mapping[str, str],
        timeout: float,
        max_output_chars: int,
    ) -> ProfileProcessResult:
        del argv, cwd, env, timeout, max_output_chars
        raise TimeoutError("executor deadline")

    raising = AboxProfilerRunner(
        adapter=adapter,
        artifact_store=InMemoryArtifactStore(),
        executor=raising_timeout_executor,
    )
    with pytest.raises(ProfileTimeoutError, match="timed out"):
        raising.capture(_request(tmp_path, spec, WorkloadInvocation(("python", "work.py"))))

    class EscapingSynthetic(SyntheticProfilerAdapter):
        def prepare(self, spec: ProfilerSpec, artifact_dir: Path) -> PreparedCapture:
            del spec, artifact_dir
            return PreparedCapture(Path("/tmp/not-runner-owned.profile"), "synthetic")

    escaping = AboxProfilerRunner(
        adapter=EscapingSynthetic(),
        artifact_store=InMemoryArtifactStore(),
        executor=timeout_executor,
    )
    with pytest.raises(ProfileArtifactError, match="escapes"):
        escaping.capture(_request(tmp_path, spec, WorkloadInvocation(("python", "work.py"))))


def test_runner_enforces_artifact_bound_even_for_a_bad_adapter(tmp_path: Path) -> None:
    class OversizedSynthetic(SyntheticProfilerAdapter):
        def collect(
            self,
            prepared: PreparedCapture,
            *,
            diagnostic_duration: DiagnosticDuration,
            max_bytes: int,
        ) -> CapturedProfile:
            del prepared, max_bytes
            return CapturedProfile(b"12345", "application/octet-stream", diagnostic_duration)

    def success(
        argv: Sequence[str],
        *,
        cwd: Path,
        env: Mapping[str, str],
        timeout: float,
        max_output_chars: int,
    ) -> ProfileProcessResult:
        del argv, cwd, env, timeout, max_output_chars
        return ProfileProcessResult(0)

    runner = AboxProfilerRunner(
        adapter=OversizedSynthetic(),
        artifact_store=InMemoryArtifactStore(),
        executor=success,
    )
    request = _request(
        tmp_path,
        ProfilerSpec(
            name="synthetic",
            adapter="bakudo.synthetic",
            signals=("synthetic-hotspots",),
        ),
        WorkloadInvocation(("python", "work.py")),
        limits=CaptureLimits(max_artifact_bytes=4),
    )
    with pytest.raises(ProfileArtifactError, match="5 bytes; limit is 4"):
        runner.capture(request)


def test_process_adapter_runs_functionally_without_optional_dependencies(tmp_path: Path) -> None:
    store = InMemoryArtifactStore()
    runner = AboxProfilerRunner(adapter=ProcessProfilerAdapter(), artifact_store=store)
    snapshot = runner.capture(
        _request(
            tmp_path,
            ProfilerSpec(
                name="process",
                adapter="bakudo.process",
                signals=("wall-time", "cpu-time", "peak-rss"),
            ),
            WorkloadInvocation((sys.executable, "-c", "sum(range(10000))")),
        )
    )

    assert snapshot.status is RecordStatus.completed
    assert {item.label for item in snapshot.hotspots} == {
        "wall time",
        "user CPU",
        "system CPU",
        "peak RSS",
    }


def test_builtin_adapter_rejects_symlink_artifact(tmp_path: Path) -> None:
    target = tmp_path / "secret"
    target.write_bytes(b"must-not-be-ingested")
    output = tmp_path / "profile.json"
    output.symlink_to(target)
    adapter = ProcessProfilerAdapter()

    with pytest.raises(ProfileArtifactError, match="non-symlink"):
        adapter.collect(
            PreparedCapture(output, "process"),
            diagnostic_duration=DiagnosticDuration(0.1),
            max_bytes=1_000,
        )


def test_cprofile_runner_finds_hot_function(tmp_path: Path) -> None:
    script = tmp_path / "hot.py"
    script.write_text(
        "def deliberately_hot():\n"
        "    return sum(i * i for i in range(20000))\n"
        "for _ in range(10):\n"
        "    deliberately_hot()\n"
    )
    runner = AboxProfilerRunner(
        adapter=PythonSamplingAdapter(discover_py_spy=False),
        artifact_store=InMemoryArtifactStore(),
    )

    snapshot = runner.capture(
        _request(
            tmp_path,
            ProfilerSpec(
                name="python-sampling",
                adapter="python.sampling",
                signals=("function-calls",),
            ),
            WorkloadInvocation((sys.executable, "hot.py")),
        )
    )

    assert any(item.label == "deliberately_hot" for item in snapshot.hotspots)
    assert any("cProfile fallback" in warning for warning in snapshot.warnings)
