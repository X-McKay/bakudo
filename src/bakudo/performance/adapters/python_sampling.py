"""Python sampling adapter with a dependency-free cProfile fallback.

When ``py-spy`` is installed, the adapter records Speedscope samples.  In the
base installation it remains functional by wrapping a Python script/module in
the standard-library ``cProfile`` module.  Capability reporting labels that
instrumenting fallback as degraded because it perturbs call behavior more
than sampling.
"""

from __future__ import annotations

import json
import marshal
import platform
import shutil
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from ..models import EnvironmentPin, Hotspot, HotspotKind, ProfilerDescriptor, ProfilerSpec
from ..normalize import NormalizationError, RawHotspot, SymbolMap, normalize_hotspots
from ..profiler import (
    CapabilityReport,
    CapabilityState,
    CapturedProfile,
    DiagnosticDuration,
    PreparedCapture,
    WorkloadInvocation,
)
from .process import _read_bounded

_PSTATS_MEDIA_TYPE = "application/vnd.python.pstats"
_SPEEDSCOPE_MEDIA_TYPE = "application/vnd.speedscope+json"


class PythonSamplingAdapter:
    """Prefer ``py-spy`` sampling and fall back to standard-library cProfile."""

    def __init__(
        self,
        *,
        py_spy_path: str | None = None,
        py_spy_version: str | None = None,
        discover_py_spy: bool = True,
        sampling_permission_verified: bool = False,
    ) -> None:
        self._py_spy_path = py_spy_path
        if self._py_spy_path is None and discover_py_spy:
            self._py_spy_path = shutil.which("py-spy")
        self._py_spy_version = py_spy_version
        self._sampling_permission_verified = sampling_permission_verified

    @property
    def descriptor(self) -> ProfilerDescriptor:
        if self._py_spy_path:
            return ProfilerDescriptor(
                name="python-sampling",
                adapter="python.sampling",
                version=f"py-spy-{self._py_spy_version or 'unknown'}",
                signals=("cpu-samples", "call-stacks"),
            )
        return ProfilerDescriptor(
            name="python-sampling",
            adapter="python.sampling",
            version=f"cProfile-{platform.python_version()}",
            signals=("function-calls", "cpu-time"),
        )

    def check_capabilities(self, environment: EnvironmentPin) -> CapabilityReport:
        del environment
        if self._py_spy_path:
            verified = self._sampling_permission_verified and self._py_spy_version is not None
            return CapabilityReport(
                self.descriptor,
                CapabilityState.available if verified else CapabilityState.degraded,
                "py-spy version and guest process-inspection permission are verified"
                if verified
                else "py-spy is installed but its version or guest permission is unverified",
                "Run the abox profiler capability check for this image" if not verified else "",
            )
        return CapabilityReport(
            self.descriptor,
            CapabilityState.degraded,
            "py-spy is unavailable; using the higher-overhead cProfile fallback",
            "Install py-spy in the abox image to enable sampling without changing host privileges",
        )

    def prepare(self, spec: ProfilerSpec, artifact_dir: Path) -> PreparedCapture:
        if spec.adapter != self.descriptor.adapter:
            raise ValueError(
                f"profiler spec selects {spec.adapter!r}, expected {self.descriptor.adapter!r}"
            )
        if self._py_spy_path:
            rate = spec.options.get("samplingHz", 100)
            if isinstance(rate, bool) or not isinstance(rate, int) or not 1 <= rate <= 1_000:
                raise ValueError("samplingHz must be an integer between 1 and 1000")
            return PreparedCapture(
                artifact_dir / "python-profile.speedscope.json",
                "py-spy",
                (("samplingHz", str(rate)),),
            )
        return PreparedCapture(artifact_dir / "python-profile.pstats", "cprofile")

    def build_argv(
        self, prepared: PreparedCapture, invocation: WorkloadInvocation
    ) -> tuple[str, ...]:
        if prepared.mode == "py-spy":
            if not self._py_spy_path:
                raise ValueError("py-spy capture was prepared without a py-spy executable")
            rate = prepared.metadata_dict()["samplingHz"]
            return (
                self._py_spy_path,
                "record",
                "--format",
                "speedscope",
                "--rate",
                rate,
                "--output",
                str(prepared.output_path),
                "--",
                *invocation.argv,
            )

        if prepared.mode != "cprofile":
            raise ValueError(f"unsupported Python capture mode: {prepared.mode}")
        executable, *arguments = invocation.argv
        executable_name = Path(executable).name.lower()
        if not executable_name.startswith("python"):
            raise ValueError("cProfile fallback requires a Python executable invocation")
        if not arguments or arguments[0] in {"-c", "-"}:
            raise ValueError("cProfile fallback requires a Python script or -m module invocation")
        return (
            executable,
            "-m",
            "cProfile",
            "-o",
            str(prepared.output_path),
            *arguments,
        )

    def collect(
        self,
        prepared: PreparedCapture,
        *,
        diagnostic_duration: DiagnosticDuration,
        max_bytes: int,
    ) -> CapturedProfile:
        media_type = (
            _SPEEDSCOPE_MEDIA_TYPE if prepared.mode == "py-spy" else _PSTATS_MEDIA_TYPE
        )
        return CapturedProfile(
            _read_bounded(prepared.output_path, max_bytes),
            media_type,
            diagnostic_duration,
            warnings=("instrumenting cProfile fallback",) if prepared.mode == "cprofile" else (),
        )

    def normalize(
        self, artifact: CapturedProfile, symbols: SymbolMap
    ) -> tuple[Hotspot, ...]:
        if artifact.media_type == _PSTATS_MEDIA_TYPE:
            return _normalize_pstats(artifact.content, symbols)
        if artifact.media_type == _SPEEDSCOPE_MEDIA_TYPE:
            return _normalize_speedscope(artifact.content, symbols)
        raise NormalizationError(f"unsupported Python profile media type: {artifact.media_type}")


def _normalize_pstats(content: bytes, symbols: SymbolMap) -> tuple[Hotspot, ...]:
    try:
        stats: Any = marshal.loads(content)
    except (EOFError, TypeError, ValueError) as exc:
        raise NormalizationError("malformed pstats artifact") from exc
    if not isinstance(stats, dict):
        raise NormalizationError("malformed pstats artifact")

    parsed: list[tuple[str, int, str, int, int, float, float]] = []
    for raw_key, raw_value in stats.items():
        if (
            not isinstance(raw_key, tuple)
            or len(raw_key) != 3
            or not isinstance(raw_value, tuple)
            or len(raw_value) < 4
        ):
            raise NormalizationError("malformed pstats entry")
        filename, line, function = raw_key
        primitive_calls, total_calls, exclusive, inclusive = raw_value[:4]
        try:
            parsed.append(
                (
                    str(filename),
                    int(line),
                    str(function),
                    int(primitive_calls),
                    int(total_calls),
                    float(exclusive),
                    float(inclusive),
                )
            )
        except (TypeError, ValueError) as exc:
            raise NormalizationError("malformed pstats values") from exc

    total_exclusive = sum(max(0.0, item[5]) for item in parsed)
    rows = tuple(
        RawHotspot(
            kind=HotspotKind.function,
            label=function,
            source_path=filename,
            source_line=line if line > 0 else None,
            inclusive_cost=max(0.0, inclusive),
            exclusive_cost=max(0.0, exclusive),
            sample_count=max(0, total_calls),
            percentage=(100.0 * max(0.0, exclusive) / total_exclusive)
            if total_exclusive
            else None,
            quality="unknown" if filename.startswith(("<", "~")) else "resolved",
            extensions={"python.primitiveCalls": max(0, primitive_calls)},
        )
        for filename, line, function, primitive_calls, total_calls, exclusive, inclusive in parsed
    )
    return normalize_hotspots(rows, symbols)


def _normalize_speedscope(content: bytes, symbols: SymbolMap) -> tuple[Hotspot, ...]:
    try:
        document = json.loads(content)
        frames = document["shared"]["frames"]
        profiles = document["profiles"]
        if not isinstance(frames, list) or not isinstance(profiles, list):
            raise TypeError
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise NormalizationError("malformed Speedscope artifact") from exc

    inclusive: dict[int, float] = {}
    exclusive: dict[int, float] = {}
    counts: dict[int, int] = {}
    for profile in profiles:
        if not isinstance(profile, dict) or profile.get("type") != "sampled":
            raise NormalizationError("only sampled Speedscope profiles are supported")
        samples = profile.get("samples")
        weights = profile.get("weights")
        if not isinstance(samples, list):
            raise NormalizationError("malformed Speedscope samples")
        if weights is None:
            weights = [1.0] * len(samples)
        if not isinstance(weights, list) or len(weights) != len(samples):
            raise NormalizationError("Speedscope weights do not match samples")
        for stack, raw_weight in zip(samples, weights, strict=True):
            if not isinstance(stack, list):
                raise NormalizationError("malformed Speedscope stack")
            try:
                weight = float(raw_weight)
            except (TypeError, ValueError) as exc:
                raise NormalizationError("malformed Speedscope weight") from exc
            if weight < 0:
                raise NormalizationError("Speedscope weights must be non-negative")
            seen: set[int] = set()
            for raw_index in stack:
                if not isinstance(raw_index, int) or not 0 <= raw_index < len(frames):
                    raise NormalizationError("Speedscope frame index is out of bounds")
                # Recursion contributes once to inclusive sample weight for the
                # normalized function; call counts remain sample-based.
                if raw_index not in seen:
                    inclusive[raw_index] = inclusive.get(raw_index, 0.0) + weight
                    counts[raw_index] = counts.get(raw_index, 0) + 1
                    seen.add(raw_index)
            if stack:
                leaf = stack[-1]
                exclusive[leaf] = exclusive.get(leaf, 0.0) + weight

    total_weight = sum(exclusive.values())
    rows: list[RawHotspot] = []
    for index, cost in inclusive.items():
        frame = frames[index]
        if not isinstance(frame, Mapping):
            raise NormalizationError("malformed Speedscope frame")
        label = frame.get("name", "<unknown>")
        if not isinstance(label, str):
            raise NormalizationError("malformed Speedscope frame name")
        path = frame.get("file")
        line = frame.get("line")
        rows.append(
            RawHotspot(
                kind=HotspotKind.function,
                label=label,
                source_path=path if isinstance(path, str) else None,
                source_line=line if isinstance(line, int) and line > 0 else None,
                inclusive_cost=cost,
                exclusive_cost=exclusive.get(index, 0.0),
                sample_count=counts.get(index, 0),
                percentage=(100.0 * exclusive.get(index, 0.0) / total_weight)
                if total_weight
                else None,
                quality="resolved" if isinstance(path, str) else "unknown",
                extensions={"speedscope.frameIndex": index},
            )
        )
    return normalize_hotspots(rows, symbols)
