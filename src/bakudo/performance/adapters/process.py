"""Dependency-free process resource capture adapter and guest-side wrapper."""

from __future__ import annotations

import argparse
import json
import os
import resource
import stat
import subprocess
import sys
import time
from collections.abc import Sequence
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
    ProfileArtifactError,
    WorkloadInvocation,
)

_MEDIA_TYPE = "application/vnd.bakudo.process-profile+json"


def _read_bounded(path: Path, max_bytes: int) -> bytes:
    try:
        metadata = path.lstat()
    except OSError as exc:
        raise ProfileArtifactError(f"profile artifact is missing: {path.name}") from exc
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
        raise ProfileArtifactError("profile artifact must be a regular, non-symlink file")
    size = metadata.st_size
    if size > max_bytes:
        raise ProfileArtifactError(f"profile is {size} bytes; limit is {max_bytes} bytes")
    try:
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(path, flags)
    except OSError as exc:
        raise ProfileArtifactError(f"cannot read profile artifact: {path.name}") from exc
    try:
        opened = os.fstat(descriptor)
        if not stat.S_ISREG(opened.st_mode) or opened.st_size != size:
            raise ProfileArtifactError("profile artifact changed before it was opened")
        with os.fdopen(descriptor, "rb", closefd=False) as stream:
            content = stream.read(max_bytes + 1)
        after = os.fstat(descriptor)
    finally:
        os.close(descriptor)
    if len(content) > max_bytes:
        raise ProfileArtifactError(
            f"profile exceeds the {max_bytes}-byte limit while being read"
        )
    if len(content) != size or after.st_size != size:
        raise ProfileArtifactError("profile artifact changed while it was being read")
    return content


class ProcessProfilerAdapter:
    """Capture wall, child CPU, and peak RSS without language dependencies."""

    @property
    def descriptor(self) -> ProfilerDescriptor:
        return ProfilerDescriptor(
            name="process-resources",
            adapter="bakudo.process",
            version="1",
            signals=("wall-time", "cpu-time", "peak-rss"),
        )

    def check_capabilities(self, environment: EnvironmentPin) -> CapabilityReport:
        del environment
        return CapabilityReport(self.descriptor, CapabilityState.available)

    def prepare(self, spec: ProfilerSpec, artifact_dir: Path) -> PreparedCapture:
        if spec.adapter != self.descriptor.adapter:
            raise ValueError(
                f"profiler spec selects {spec.adapter!r}, expected {self.descriptor.adapter!r}"
            )
        return PreparedCapture(artifact_dir / "process-profile.json", "process")

    def build_argv(
        self, prepared: PreparedCapture, invocation: WorkloadInvocation
    ) -> tuple[str, ...]:
        return (
            sys.executable,
            "-m",
            "bakudo.performance.adapters.process",
            "--output",
            str(prepared.output_path),
            "--",
            *invocation.argv,
        )

    def collect(
        self,
        prepared: PreparedCapture,
        *,
        diagnostic_duration: DiagnosticDuration,
        max_bytes: int,
    ) -> CapturedProfile:
        return CapturedProfile(
            _read_bounded(prepared.output_path, max_bytes),
            _MEDIA_TYPE,
            diagnostic_duration,
        )

    def normalize(
        self, artifact: CapturedProfile, symbols: SymbolMap
    ) -> tuple[Hotspot, ...]:
        del symbols
        if artifact.media_type != _MEDIA_TYPE:
            raise NormalizationError(f"unsupported process media type: {artifact.media_type}")
        try:
            document = json.loads(artifact.content)
            if document.get("schemaVersion") != 1:
                raise ValueError("unsupported schema")
            values = {
                "wall time": (float(document["elapsedSeconds"]), "seconds"),
                "user CPU": (float(document["userCpuSeconds"]), "seconds"),
                "system CPU": (float(document["systemCpuSeconds"]), "seconds"),
                "peak RSS": (float(document["maxRssBytes"]), "bytes"),
            }
            rows = tuple(
                RawHotspot(
                    kind=HotspotKind.resource,
                    label=label,
                    inclusive_cost=value,
                    sample_count=1,
                    quality="process",
                    extensions={"bakudo.unit": unit},
                )
                for label, (value, unit) in values.items()
            )
        except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
            raise NormalizationError("malformed process profile") from exc
        return normalize_hotspots(rows)


def _max_rss_bytes(value: int) -> int:
    # Darwin reports bytes; Linux and the other supported Unix guests report
    # KiB. This metadata is diagnostic and remains separate from proof metrics.
    return value if sys.platform == "darwin" else value * 1024


def _run_and_write(command: Sequence[str], output: Path) -> int:
    before = resource.getrusage(resource.RUSAGE_CHILDREN)
    started = time.monotonic()
    completed = subprocess.run(list(command), check=False)
    elapsed = time.monotonic() - started
    after = resource.getrusage(resource.RUSAGE_CHILDREN)
    document: dict[str, Any] = {
        "schemaVersion": 1,
        "elapsedSeconds": elapsed,
        "userCpuSeconds": max(0.0, after.ru_utime - before.ru_utime),
        "systemCpuSeconds": max(0.0, after.ru_stime - before.ru_stime),
        "maxRssBytes": _max_rss_bytes(max(0, after.ru_maxrss)),
        "exitCode": completed.returncode,
    }
    temporary = output.with_suffix(output.suffix + ".tmp")
    payload = json.dumps(document, sort_keys=True, separators=(",", ":")).encode()
    flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(temporary, flags, 0o600)
    try:
        with os.fdopen(descriptor, "wb", closefd=False) as stream:
            stream.write(payload)
            stream.flush()
    finally:
        os.close(descriptor)
    os.replace(temporary, output)
    return completed.returncode


def _main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    command = args.command
    if command[:1] == ["--"]:
        command = command[1:]
    if not command:
        parser.error("a command is required after --")
    return _run_and_write(command, args.output)


if __name__ == "__main__":  # pragma: no cover - exercised through the adapter runner
    raise SystemExit(_main())
