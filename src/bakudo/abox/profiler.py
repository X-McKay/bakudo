"""Trusted, bounded runner for diagnostic capture in a provisioned abox workspace.

This component does not provision a repository or widen sandbox privileges.
Its ``workspace`` must already be an isolated abox guest/worktree selected by
the orchestration layer.  The injected executor seam keeps command building,
timeouts, cleanup, and artifact handling independently testable.
"""

from __future__ import annotations

import hashlib
import os
import subprocess
import tempfile
import threading
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from .. import ids
from ..performance.artifacts import ArtifactInput, ArtifactStore
from ..performance.models import (
    EnvironmentPin,
    PerformanceSnapshot,
    RawProfileArtifact,
    RecordStatus,
    canonical_digest,
)
from ..performance.normalize import SymbolMap
from ..performance.profiler import (
    CapabilityState,
    DiagnosticDuration,
    ProfileArtifactError,
    ProfileCaptureRequest,
    ProfileExecutionError,
    ProfilerAdapter,
    ProfilerUnsupportedError,
    ProfileTimeoutError,
)

_BASE_ENVIRONMENT_NAMES = ("PATH", "LANG", "LC_ALL", "TZ", "SYSTEMROOT")


@dataclass(frozen=True)
class ProfileProcessResult:
    """Bounded result returned by a capture executor."""

    exit_code: int
    stdout: str = ""
    stderr: str = ""
    timed_out: bool = False


class CaptureExecutor(Protocol):
    """Execute one shell-free command inside the already provisioned guest."""

    def __call__(
        self,
        argv: Sequence[str],
        *,
        cwd: Path,
        env: Mapping[str, str],
        timeout: float,
        max_output_chars: int,
    ) -> ProfileProcessResult:
        ...


def _read_bounded_pipe(
    stream: object,
    destination: list[bytes],
    *,
    max_bytes: int,
) -> None:
    retained = 0
    while True:
        chunk = stream.read(8_192)  # type: ignore[attr-defined]
        if not chunk:
            break
        if retained < max_bytes:
            bounded = chunk[: max_bytes - retained]
            destination.append(bounded)
            retained += len(bounded)


def subprocess_capture_executor(
    argv: Sequence[str],
    *,
    cwd: Path,
    env: Mapping[str, str],
    timeout: float,
    max_output_chars: int,
) -> ProfileProcessResult:
    """Run argv directly and retain only a bounded prefix of each output stream."""

    if not argv:
        raise ValueError("capture argv must not be empty")
    try:
        process = subprocess.Popen(
            list(argv),
            cwd=cwd,
            env=dict(env),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except OSError as exc:
        raise ProfileExecutionError(f"cannot start profiler command: {exc}") from exc

    assert process.stdout is not None
    assert process.stderr is not None
    stdout_chunks: list[bytes] = []
    stderr_chunks: list[bytes] = []
    readers = (
        threading.Thread(
            target=_read_bounded_pipe,
            args=(process.stdout, stdout_chunks),
            kwargs={"max_bytes": max_output_chars},
            daemon=True,
        ),
        threading.Thread(
            target=_read_bounded_pipe,
            args=(process.stderr, stderr_chunks),
            kwargs={"max_bytes": max_output_chars},
            daemon=True,
        ),
    )
    for reader in readers:
        reader.start()

    timed_out = False
    try:
        process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
    finally:
        for reader in readers:
            reader.join(timeout=5)
        process.stdout.close()
        process.stderr.close()

    return ProfileProcessResult(
        exit_code=124 if timed_out else process.returncode,
        stdout=b"".join(stdout_chunks).decode("utf-8", errors="replace"),
        stderr=b"".join(stderr_chunks).decode("utf-8", errors="replace"),
        timed_out=timed_out,
    )


def _safe_cwd(workspace: Path, relative_cwd: str) -> Path:
    try:
        root = workspace.resolve(strict=True)
        cwd = (root / relative_cwd).resolve(strict=True)
    except OSError as exc:
        raise ProfileExecutionError("capture workspace or cwd does not exist") from exc
    if not root.is_dir() or not cwd.is_dir() or not cwd.is_relative_to(root):
        raise ProfileExecutionError("capture cwd escapes the provisioned workspace")
    return cwd


def _capture_environment(declared: Mapping[str, str]) -> dict[str, str]:
    environment = {
        name: os.environ[name] for name in _BASE_ENVIRONMENT_NAMES if name in os.environ
    }
    environment.update(declared)
    return environment


def _instrumented_environment(
    environment: EnvironmentPin, adapter: ProfilerAdapter
) -> EnvironmentPin:
    descriptor = adapter.descriptor
    if environment.profiler_adapter is not None and (
        environment.profiler_adapter != descriptor.adapter
        or environment.profiler_version != descriptor.version
    ):
        raise ProfileExecutionError("environment pin selects a different profiler adapter")
    return environment.model_copy(
        update={
            "profiler_adapter": descriptor.adapter,
            "profiler_version": descriptor.version,
        }
    )


class AboxProfilerRunner:
    """Capture one diagnostic snapshot without producing measurement samples."""

    def __init__(
        self,
        *,
        adapter: ProfilerAdapter,
        artifact_store: ArtifactStore,
        executor: CaptureExecutor = subprocess_capture_executor,
        scratch_root: Path | None = None,
    ) -> None:
        self._adapter = adapter
        self._artifact_store = artifact_store
        self._executor = executor
        self._scratch_root = scratch_root

    def capture(self, request: ProfileCaptureRequest) -> PerformanceSnapshot:
        descriptor = self._adapter.descriptor
        if request.profiler.adapter != descriptor.adapter:
            raise ProfileExecutionError(
                f"profiler spec selects {request.profiler.adapter!r}, "
                f"runner provides {descriptor.adapter!r}"
            )
        unsupported_signals = sorted(set(request.profiler.signals) - set(descriptor.signals))
        if unsupported_signals:
            raise ProfileExecutionError(
                f"profiler does not provide requested signals: {', '.join(unsupported_signals)}"
            )

        report = self._adapter.check_capabilities(request.environment)
        if report.state is CapabilityState.unavailable:
            raise ProfilerUnsupportedError(report)

        cwd = _safe_cwd(request.workspace, request.invocation.cwd)
        with tempfile.TemporaryDirectory(
            prefix="bakudo-profile-",
            dir=self._scratch_root,
        ) as temporary:
            artifact_dir = Path(temporary).resolve()
            prepared = self._adapter.prepare(request.profiler, artifact_dir)
            try:
                output_path = prepared.output_path.resolve(strict=False)
            except OSError as exc:
                raise ProfileArtifactError("cannot resolve profiler output path") from exc
            if not output_path.is_relative_to(artifact_dir):
                raise ProfileArtifactError("profiler output path escapes its bounded directory")

            argv = self._adapter.build_argv(prepared, request.invocation)
            if not argv or any(not isinstance(item, str) or not item for item in argv):
                raise ProfileExecutionError("profiler adapter produced invalid argv")

            started = time.monotonic()
            try:
                result = self._executor(
                    argv,
                    cwd=cwd,
                    env=_capture_environment(request.invocation.environment()),
                    timeout=request.limits.timeout_seconds,
                    max_output_chars=request.limits.max_output_chars,
                )
            except TimeoutError as exc:
                raise ProfileTimeoutError(
                    f"profile capture timed out after {request.limits.timeout_seconds:g} seconds"
                ) from exc
            duration = DiagnosticDuration(time.monotonic() - started)
            if result.timed_out:
                raise ProfileTimeoutError(
                    f"profile capture timed out after {request.limits.timeout_seconds:g} seconds"
                )
            if result.exit_code != 0:
                raise ProfileExecutionError(
                    f"profiled workload exited with code {result.exit_code}; "
                    "captured output is not included in the error to avoid leaking secrets"
                )

            captured = self._adapter.collect(
                prepared,
                diagnostic_duration=duration,
                max_bytes=request.limits.max_artifact_bytes,
            )
            if len(captured.content) > request.limits.max_artifact_bytes:
                raise ProfileArtifactError(
                    f"profile is {len(captured.content)} bytes; "
                    f"limit is {request.limits.max_artifact_bytes} bytes"
                )
            if not captured.complete:
                raise ProfileArtifactError("incomplete profile artifacts cannot form snapshots")
            hotspots = self._adapter.normalize(
                captured,
                SymbolMap(
                    repository_root=request.symbol_root
                    or request.workspace.resolve().as_posix()
                ),
            )
            expected_digest = f"sha256:{hashlib.sha256(captured.content).hexdigest()}"
            stored = self._artifact_store.put(
                ArtifactInput(
                    content=captured.content,
                    media_type=captured.media_type,
                    visibility="restricted",
                    retention_class="profile",
                )
            )
            if stored.digest != expected_digest or stored.size_bytes != len(captured.content):
                raise ProfileArtifactError("artifact store returned inconsistent profile metadata")

        warnings = list(captured.warnings)
        if report.state is CapabilityState.degraded and report.reason:
            warnings.append(report.reason)
        return PerformanceSnapshot(
            id=request.snapshot_id or ids.new_snapshot_id(),
            workload=request.workload,
            revision=request.revision,
            environment=_instrumented_environment(request.environment, self._adapter),
            profiler_spec_digest=canonical_digest(request.profiler),
            descriptor=descriptor,
            # The explicit unwrap happens only when constructing diagnostic
            # evidence. No float-valued measurement request/result is exposed.
            capture_seconds=captured.diagnostic_duration.seconds,
            hotspots=hotspots,
            artifacts=(
                RawProfileArtifact(
                    uri=stored.uri,
                    digest=stored.digest,
                    media_type=stored.media_type,
                    byte_size=stored.size_bytes,
                    complete=True,
                ),
            ),
            warnings=tuple(dict.fromkeys(warnings)),
            sanitization_status="sanitized",
            visibility="restricted",
            status=RecordStatus.completed,
        )
