from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from bakudo.performance.adapters.process import ProcessProfilerAdapter
from bakudo.performance.adapters.python_sampling import PythonSamplingAdapter
from bakudo.performance.adapters.synthetic import SyntheticProfilerAdapter
from bakudo.performance.models import EnvironmentPin, HotspotKind, ProfilerSpec
from bakudo.performance.normalize import NormalizationError, RawHotspot, SymbolMap
from bakudo.performance.profiler import (
    CapabilityState,
    DiagnosticDuration,
    WorkloadInvocation,
)

_DIGEST = "sha256:" + "0" * 64


def _environment() -> EnvironmentPin:
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


@pytest.mark.parametrize(
    "adapter",
    [
        SyntheticProfilerAdapter(),
        ProcessProfilerAdapter(),
        PythonSamplingAdapter(discover_py_spy=False),
    ],
)
def test_capability_check_is_repeatable_and_side_effect_free(adapter: object) -> None:
    first = adapter.check_capabilities(_environment())  # type: ignore[attr-defined]
    second = adapter.check_capabilities(_environment())  # type: ignore[attr-defined]

    assert first == second
    assert first.usable
    assert first.state in {CapabilityState.available, CapabilityState.degraded}


def test_python_adapter_reports_and_builds_cprofile_fallback(tmp_path: Path) -> None:
    adapter = PythonSamplingAdapter(discover_py_spy=False)
    spec = ProfilerSpec(
        name="python-sampling",
        adapter="python.sampling",
        signals=("function-calls",),
    )

    report = adapter.check_capabilities(_environment())
    prepared = adapter.prepare(spec, tmp_path)
    argv = adapter.build_argv(
        prepared,
        WorkloadInvocation((sys.executable, "-m", "example", "--flag")),
    )

    assert report.state is CapabilityState.degraded
    assert "cProfile" in report.reason
    assert argv == (
        sys.executable,
        "-m",
        "cProfile",
        "-o",
        str(prepared.output_path),
        "-m",
        "example",
        "--flag",
    )
    with pytest.raises(ValueError, match="script or -m module"):
        adapter.build_argv(
            prepared,
            WorkloadInvocation((sys.executable, "-c", "print('not wrapped')")),
        )


def test_python_adapter_builds_py_spy_argv_without_a_shell(tmp_path: Path) -> None:
    adapter = PythonSamplingAdapter(
        py_spy_path="/guest/bin/py-spy",
        py_spy_version="0.4.0",
        discover_py_spy=False,
        sampling_permission_verified=True,
    )
    spec = ProfilerSpec(
        name="python-sampling",
        adapter="python.sampling",
        signals=("cpu-samples",),
        options={"samplingHz": 77},
    )

    prepared = adapter.prepare(spec, tmp_path)
    assert adapter.check_capabilities(_environment()).state is CapabilityState.available
    argv = adapter.build_argv(
        prepared,
        WorkloadInvocation(("python", "script.py", "value with spaces", "; touch nope")),
    )

    assert argv[:8] == (
        "/guest/bin/py-spy",
        "record",
        "--format",
        "speedscope",
        "--rate",
        "77",
        "--output",
        str(prepared.output_path),
    )
    assert argv[-4:] == ("python", "script.py", "value with spaces", "; touch nope")


def test_py_spy_binary_without_verified_guest_capability_is_degraded() -> None:
    adapter = PythonSamplingAdapter(
        py_spy_path="/guest/bin/py-spy",
        discover_py_spy=False,
    )

    report = adapter.check_capabilities(_environment())

    assert report.state is CapabilityState.degraded
    assert "unverified" in report.reason


def test_cprofile_adapter_produces_normalized_function_hotspot(tmp_path: Path) -> None:
    script = tmp_path / "work.py"
    script.write_text(
        "def deliberately_hot():\n"
        "    return sum(i * i for i in range(10000))\n"
        "for _ in range(20):\n"
        "    deliberately_hot()\n"
    )
    adapter = PythonSamplingAdapter(discover_py_spy=False)
    spec = ProfilerSpec(
        name="python-sampling",
        adapter="python.sampling",
        signals=("function-calls",),
    )
    prepared = adapter.prepare(spec, tmp_path)
    argv = adapter.build_argv(
        prepared,
        WorkloadInvocation((sys.executable, str(script))),
    )

    completed = subprocess.run(argv, cwd=tmp_path, check=False, capture_output=True)
    assert completed.returncode == 0
    artifact = adapter.collect(
        prepared,
        diagnostic_duration=DiagnosticDuration(0.1),
        max_bytes=2_000_000,
    )
    hotspots = adapter.normalize(artifact, SymbolMap(repository_root=tmp_path.as_posix()))

    hot = next(item for item in hotspots if item.label == "deliberately_hot")
    assert hot.source_path == "work.py"
    assert hot.sample_count == 20
    assert "instrumenting cProfile fallback" in artifact.warnings


def test_synthetic_adapter_rejects_malformed_profile() -> None:
    adapter = SyntheticProfilerAdapter(
        (RawHotspot(kind=HotspotKind.function, label="hot", inclusive_cost=1),)
    )
    artifact = adapter.collect(
        adapter.prepare(
            ProfilerSpec(
                name="synthetic",
                adapter="bakudo.synthetic",
                signals=("synthetic-hotspots",),
            ),
            Path("/tmp"),
        ),
        diagnostic_duration=DiagnosticDuration(0),
        max_bytes=1_000,
    )
    malformed = artifact.__class__(
        json.dumps({"schemaVersion": 1}).encode(),
        artifact.media_type,
        artifact.diagnostic_duration,
    )
    with pytest.raises(NormalizationError, match="malformed synthetic profile"):
        adapter.normalize(malformed, SymbolMap())
