"""Ports and nominal types for diagnostic performance capture.

Profiling is deliberately not measurement.  In particular,
``DiagnosticDuration`` is a nominal wrapper rather than a float so code that
collects profiled wall time cannot accidentally pass it to the uninstrumented
measurement sample constructors.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path, PurePosixPath
from typing import TYPE_CHECKING, Protocol

from .models import (
    EnvironmentPin,
    Hotspot,
    PerformanceSnapshot,
    ProfilerDescriptor,
    ProfilerSpec,
    RevisionPin,
    WorkloadPin,
)

if TYPE_CHECKING:
    from .normalize import SymbolMap


DEFAULT_MAX_PROFILE_BYTES = 16 * 1024 * 1024
DEFAULT_CAPTURE_TIMEOUT_SECONDS = 300.0


class CapabilityState(str, Enum):
    """Availability of an optional profiler in a pinned environment."""

    available = "available"
    degraded = "degraded"
    unavailable = "unavailable"


@dataclass(frozen=True)
class CapabilityReport:
    """Side-effect-free capability result suitable for ``bakudo doctor``."""

    descriptor: ProfilerDescriptor
    state: CapabilityState
    reason: str = ""
    remediation: str = ""

    @property
    def usable(self) -> bool:
        return self.state is not CapabilityState.unavailable


@dataclass(frozen=True)
class DiagnosticDuration:
    """Wall duration observed while a profiler was enabled.

    This type intentionally has no ``__float__`` implementation.  Converting
    it into a snapshot is an explicit operation in the trusted capture runner;
    measurement sample APIs continue to accept plain uninstrumented numbers.
    """

    seconds: float

    def __post_init__(self) -> None:
        if not math.isfinite(self.seconds) or self.seconds < 0:
            raise ValueError("diagnostic duration must be finite and non-negative")


@dataclass(frozen=True)
class WorkloadInvocation:
    """A shell-free command invocation relative to a provisioned workspace."""

    argv: tuple[str, ...]
    cwd: str = "."
    env: tuple[tuple[str, str], ...] = ()

    def __post_init__(self) -> None:
        if not self.argv or any(not isinstance(item, str) or not item for item in self.argv):
            raise ValueError("argv must contain at least one non-empty string")
        if any("\x00" in item for item in self.argv):
            raise ValueError("argv cannot contain NUL bytes")
        if self.cwd != ".":
            path = PurePosixPath(self.cwd)
            if (
                not self.cwd
                or "\\" in self.cwd
                or path.is_absolute()
                or ".." in path.parts
                or "." in path.parts
                or path.as_posix() != self.cwd
            ):
                raise ValueError("cwd must be a normalized relative POSIX path")
        names: set[str] = set()
        for name, value in self.env:
            if not re.fullmatch(r"[A-Z_][A-Z0-9_]{0,127}", name):
                raise ValueError(f"invalid environment variable name: {name!r}")
            if name in names:
                raise ValueError(f"duplicate environment variable: {name}")
            if "\x00" in value:
                raise ValueError("environment values cannot contain NUL bytes")
            names.add(name)

    def environment(self) -> dict[str, str]:
        return dict(self.env)


@dataclass(frozen=True)
class CaptureLimits:
    """Hard bounds enforced by the trusted capture runner."""

    timeout_seconds: float = DEFAULT_CAPTURE_TIMEOUT_SECONDS
    max_artifact_bytes: int = DEFAULT_MAX_PROFILE_BYTES
    max_output_chars: int = 20_000

    def __post_init__(self) -> None:
        if not math.isfinite(self.timeout_seconds) or self.timeout_seconds <= 0:
            raise ValueError("capture timeout must be finite and positive")
        if self.max_artifact_bytes < 1:
            raise ValueError("max_artifact_bytes must be at least 1")
        if self.max_output_chars < 0:
            raise ValueError("max_output_chars must not be negative")


@dataclass(frozen=True)
class PreparedCapture:
    """Adapter-specific preparation constrained to a runner-owned directory."""

    output_path: Path
    mode: str
    metadata: tuple[tuple[str, str], ...] = ()

    def __post_init__(self) -> None:
        if not self.mode:
            raise ValueError("capture mode must not be empty")

    def metadata_dict(self) -> dict[str, str]:
        return dict(self.metadata)


@dataclass(frozen=True)
class CapturedProfile:
    """Bounded raw diagnostic output collected before artifact persistence."""

    content: bytes
    media_type: str
    diagnostic_duration: DiagnosticDuration
    complete: bool = True
    warnings: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if not isinstance(self.content, bytes):
            raise TypeError("profile content must be bytes")
        if not self.media_type.strip():
            raise ValueError("profile media_type must not be empty")


@dataclass(frozen=True)
class ProfileCaptureRequest:
    """Pinned request for one diagnostic capture in a provisioned workspace."""

    idempotency_key: str
    workload: WorkloadPin
    revision: RevisionPin
    environment: EnvironmentPin
    profiler: ProfilerSpec
    workspace: Path
    invocation: WorkloadInvocation
    snapshot_id: str | None = None
    symbol_root: str | None = None
    limits: CaptureLimits = field(default_factory=CaptureLimits)

    def __post_init__(self) -> None:
        if not self.idempotency_key.strip():
            raise ValueError("idempotency_key must not be empty")
        if not self.workspace.is_absolute():
            raise ValueError("workspace must be an absolute path")
        if self.snapshot_id is not None and not self.snapshot_id.strip():
            raise ValueError("snapshot_id must not be empty")
        if self.symbol_root is not None:
            root = PurePosixPath(self.symbol_root)
            if "\\" in self.symbol_root or "\x00" in self.symbol_root or not root.is_absolute():
                raise ValueError("symbol_root must be an absolute POSIX path")


class ProfileCaptureError(RuntimeError):
    """Base class for bounded diagnostic-capture failures."""


class ProfilerUnsupportedError(ProfileCaptureError):
    """Raised when a requested adapter cannot run in the environment."""

    def __init__(self, report: CapabilityReport) -> None:
        message = report.reason or f"profiler {report.descriptor.name!r} is unavailable"
        super().__init__(message)
        self.report = report


class ProfileArtifactError(ProfileCaptureError):
    """Raised for absent, malformed, or over-limit raw profiler output."""


class ProfileExecutionError(ProfileCaptureError):
    """Raised when the profiled workload cannot execute successfully."""


class ProfileTimeoutError(ProfileExecutionError):
    """Raised when diagnostic capture exceeds its declared deadline."""


class ProfilerAdapter(Protocol):
    """Pure command/normalization adapter driven by a trusted runner."""

    @property
    def descriptor(self) -> ProfilerDescriptor: ...

    def check_capabilities(self, environment: EnvironmentPin) -> CapabilityReport: ...

    def prepare(self, spec: ProfilerSpec, artifact_dir: Path) -> PreparedCapture: ...

    def build_argv(
        self, prepared: PreparedCapture, invocation: WorkloadInvocation
    ) -> tuple[str, ...]: ...

    def collect(
        self,
        prepared: PreparedCapture,
        *,
        diagnostic_duration: DiagnosticDuration,
        max_bytes: int,
    ) -> CapturedProfile: ...

    def normalize(self, artifact: CapturedProfile, symbols: SymbolMap) -> tuple[Hotspot, ...]: ...


class ProfilerRunner(Protocol):
    """Isolation boundary that returns diagnostic evidence, never measurement."""

    def capture(self, request: ProfileCaptureRequest) -> PerformanceSnapshot: ...
