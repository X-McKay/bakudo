"""Fresh-abox composition for immutable diagnostic profile capture.

The lower-level :mod:`bakudo.abox.profiler` runner owns adapter execution,
normalization, and artifact persistence.  This module supplies its missing
isolation boundary: it verifies all pins, starts one fresh abox task at the
exact revision, stages the immutable workload bundle, copies only the bounded
profile artifact out of the resulting worktree, and always tears the task down.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path, PurePosixPath
from typing import Protocol
from urllib.parse import unquote, urlparse

from .. import ids
from ..performance.adapters.process import ProcessProfilerAdapter, _read_bounded
from ..performance.adapters.python_sampling import PythonSamplingAdapter
from ..performance.artifacts import ArtifactRef, ArtifactStore, DirectoryArtifactStore
from ..performance.models import (
    EnvironmentPin,
    PerformanceSnapshot,
    ProfilerSpec,
    RevisionPin,
    canonical_digest,
)
from ..performance.profiler import (
    CaptureLimits,
    ProfileCaptureError,
    ProfileCaptureRequest,
    ProfilerAdapter,
    WorkloadInvocation,
)
from ..performance.revisions import pin_repository_revision, sha256_text
from ..performance.source import LoadedWorkload
from ..performance.verify import (
    WorkloadVerificationPolicy,
    iter_workload_files,
    verify_and_pin_workload,
)
from .profiler import AboxProfilerRunner, ProfileProcessResult
from .runner import IN_GUEST_SETUP_HEADROOM_SECONDS, SUBPROCESS_TIMEOUT_HEADROOM_SECONDS

_HOUSEKEEPING_TIMEOUT_SECONDS = 120.0
_HOUSEKEEPING_OUTPUT_CHARS = 4_096
_CANCELLED_EXIT_CODE = 130
_POLL_SECONDS = 0.1
_GUEST_OUTPUT_PATH = "/workspace/.bakudo/profile.raw"
_SNAPSHOT_ID = re.compile(r"^snapshot_[0-9A-HJKMNP-TV-Z]{26}$")

# Where the in-guest launcher reconstructs the staged workload layout. abox
# stages inputs flat (guest names may not contain "/"), so nested member
# paths are rebuilt here before the profiler argv executes.
_GUEST_WORKLOAD_ROOT = "/tmp/bakudo-workload"

_GUEST_LAUNCHER = r"""
import json, os, shutil, sys
payload = json.loads(sys.argv[1])
inputs_dir = os.environ.get("ABOX_INPUT_DIR", "/abox-meta/inputs")
for flat_name, relative in payload["files"].items():
    destination = os.path.join(payload["workload_root"], relative)
    os.makedirs(os.path.dirname(destination), exist_ok=True)
    shutil.copyfile(os.path.join(inputs_dir, flat_name), destination)
os.makedirs("/workspace/.bakudo", mode=0o700, exist_ok=True)
os.chdir(payload["cwd"])
environment = os.environ.copy()
environment.update(payload["env"])
os.execvpe(payload["argv"][0], payload["argv"], environment)
"""


class AboxProfileCaptureError(ProfileCaptureError):
    """The fresh-abox capture binding or lifecycle is invalid."""


class AboxCommandExecutor(Protocol):
    """Run one abox CLI command with bounded output and cancellation."""

    def __call__(
        self,
        argv: Sequence[str],
        *,
        timeout: float,
        max_output_chars: int,
        cancel_event: object | None = None,
    ) -> ProfileProcessResult: ...


ProfilerAdapterFactory = Callable[[ProfilerSpec], ProfilerAdapter]
RepositoryResolver = Callable[[str], Path | str | None]


def configured_profile_capture_service(
    *,
    repo_resolver: RepositoryResolver | None = None,
    candidate_patches: Mapping[str, str] | None = None,
) -> AboxProfileCaptureService:
    """Build the production capture service from explicit environment config."""

    root = os.environ.get("BAKUDO_ARTIFACT_ROOT")
    if not root:
        raise AboxProfileCaptureError(
            "BAKUDO_ARTIFACT_ROOT is required for durable diagnostic captures"
        )
    return AboxProfileCaptureService(
        DirectoryArtifactStore(Path(root)),
        repo_resolver=repo_resolver,
        candidate_patches=candidate_patches,
    )


def _read_pipe(stream: object, chunks: list[bytes], *, max_bytes: int) -> None:
    retained = 0
    while True:
        chunk = stream.read(8_192)  # type: ignore[attr-defined]
        if not chunk:
            return
        if retained < max_bytes:
            bounded = chunk[: max_bytes - retained]
            chunks.append(bounded)
            retained += len(bounded)


def bounded_abox_executor(
    argv: Sequence[str],
    *,
    timeout: float,
    max_output_chars: int,
    cancel_event: object | None = None,
) -> ProfileProcessResult:
    """Execute abox directly, retaining only bounded stdout/stderr prefixes."""

    if not argv:
        raise ValueError("abox argv must not be empty")
    try:
        process = subprocess.Popen(
            list(argv),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except OSError as exc:
        raise AboxProfileCaptureError(f"cannot start abox: {exc}") from exc

    assert process.stdout is not None
    assert process.stderr is not None
    stdout: list[bytes] = []
    stderr: list[bytes] = []
    readers = (
        threading.Thread(
            target=_read_pipe,
            args=(process.stdout, stdout),
            kwargs={"max_bytes": max_output_chars},
            daemon=True,
        ),
        threading.Thread(
            target=_read_pipe,
            args=(process.stderr, stderr),
            kwargs={"max_bytes": max_output_chars},
            daemon=True,
        ),
    )
    for reader in readers:
        reader.start()

    deadline = time.monotonic() + timeout
    timed_out = False
    cancelled = False
    while process.poll() is None:
        if cancel_event is not None and cancel_event.is_set():  # type: ignore[attr-defined]
            cancelled = True
            break
        if time.monotonic() >= deadline:
            timed_out = True
            break
        time.sleep(_POLL_SECONDS)
    if timed_out or cancelled:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()

    for reader in readers:
        reader.join(timeout=5)
    process.stdout.close()
    process.stderr.close()
    return ProfileProcessResult(
        exit_code=(
            124
            if timed_out
            else (_CANCELLED_EXIT_CODE if cancelled else process.returncode)
        ),
        stdout=b"".join(stdout).decode("utf-8", errors="replace"),
        stderr=b"".join(stderr).decode("utf-8", errors="replace"),
        timed_out=timed_out,
    )


def _default_adapter_factory(spec: ProfilerSpec) -> ProfilerAdapter:
    if spec.adapter == "python.sampling":
        # Host discovery says nothing about guest process-inspection rights.
        # The dependency-free fallback is the safe production default until a
        # guest capability probe explicitly supplies a py-spy adapter.
        return PythonSamplingAdapter(discover_py_spy=False)
    if spec.adapter == "bakudo.process":
        return ProcessProfilerAdapter()
    raise AboxProfileCaptureError(
        f"no production profile adapter is registered for {spec.adapter!r}"
    )


def _file_uri_path(uri: str) -> Path:
    parsed = urlparse(uri)
    if parsed.scheme != "file":
        raise AboxProfileCaptureError(
            f"revision source must resolve through the registry or use file://, got {uri!r}"
        )
    return Path(unquote(parsed.path)).resolve()


def _git(repo: Path, *args: str) -> None:
    try:
        result = subprocess.run(
            ["git", "-C", str(repo), *args],
            capture_output=True,
            text=True,
            timeout=120,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise AboxProfileCaptureError(f"git {args[0]} failed: {exc}") from exc
    if result.returncode != 0:
        raise AboxProfileCaptureError(
            f"git {args[0]} failed: {(result.stderr or result.stdout)[-1_000:]}"
        )


def _output_argument(argv: Sequence[str]) -> tuple[int, Path] | None:
    matches: list[tuple[int, Path]] = []
    for flag in ("-o", "--output"):
        for index, value in enumerate(argv[:-1]):
            if value == flag:
                matches.append((index + 1, Path(argv[index + 1])))
    if not matches:
        return None
    if len(matches) != 1 or not matches[0][1].is_absolute():
        raise AboxProfileCaptureError("profiler argv must contain one absolute output path")
    return matches[0]


def _guest_executable(value: str) -> str:
    path = Path(value)
    if path.is_absolute() and path.name.lower().startswith("python"):
        return "python3"
    return value


def _guest_cwd(value: str) -> str:
    if value == ".":
        return "/workspace"
    path = PurePosixPath(value)
    if path.is_absolute() or ".." in path.parts or path.as_posix() != value:
        raise AboxProfileCaptureError("workload cwd is not a safe repository-relative path")
    return f"/workspace/{value}"


class _FreshAboxExecutor:
    """Adapt one profiler argv into a fresh abox task invocation."""

    def __init__(
        self,
        *,
        abox_bin: str,
        command_executor: AboxCommandExecutor,
        repo: Path,
        base_ref: str,
        task_id: str,
        workload: LoadedWorkload,
        workload_cwd: str,
        network: str,
        cancel_event: object | None,
        max_artifact_bytes: int,
    ) -> None:
        self._abox_bin = abox_bin
        self._command_executor = command_executor
        self._repo = repo
        self._base_ref = base_ref
        self._task_id = task_id
        self._workload = workload
        self._workload_cwd = workload_cwd
        self._network = network
        self._cancel_event = cancel_event
        self._max_artifact_bytes = max_artifact_bytes

    def _staged_files(self) -> list[tuple[str, Path, str]]:
        """(flat guest name, host path, relative path) per pinned member.

        abox rejects guest names containing "/" ("must be a plain file
        name"), so members are staged flat under unique names and the
        in-guest launcher reconstructs the layout at ``workload_root``.
        """
        return [
            (f"w{index}-{path.name}", path, path.relative_to(self._workload.root).as_posix())
            for index, path in enumerate(iter_workload_files(self._workload.root))
        ]

    def _run_command(
        self,
        profiler_argv: Sequence[str],
        environment: Mapping[str, str],
        timeout: float,
    ) -> list[str]:
        staged = self._staged_files()
        payload = json.dumps(
            {
                "argv": list(profiler_argv),
                "cwd": _guest_cwd(self._workload_cwd),
                "env": dict(environment),
                "files": {flat: relative for flat, _, relative in staged},
                "workload_root": _GUEST_WORKLOAD_ROOT,
            },
            separators=(",", ":"),
        )
        guest_timeout = math.ceil(timeout) + IN_GUEST_SETUP_HEADROOM_SECONDS
        command = [
            self._abox_bin,
            "run",
            "--repo",
            str(self._repo),
            "--task",
            self._task_id,
            "--base",
            self._base_ref,
            "--timeout",
            str(guest_timeout),
            "--network",
            self._network,
        ]
        for flat, path, _ in staged:
            command += ["--input-file", f"{path}:{flat}"]
        command += ["--", "python3", "-c", _GUEST_LAUNCHER, payload]
        return command

    def _worktree(self) -> Path:
        result = self._command_executor(
            [self._abox_bin, "path", self._task_id, "--repo", str(self._repo)],
            timeout=_HOUSEKEEPING_TIMEOUT_SECONDS,
            max_output_chars=_HOUSEKEEPING_OUTPUT_CHARS,
        )
        if result.exit_code != 0:
            raise AboxProfileCaptureError("abox path did not resolve the capture worktree")
        candidate = Path(result.stdout.strip())
        if not candidate.is_absolute() or not candidate.is_dir():
            raise AboxProfileCaptureError("abox returned an invalid capture worktree path")
        return candidate.resolve()

    @staticmethod
    def _copy_artifact(source: Path, destination: Path, max_bytes: int) -> None:
        content = _read_bounded(source, max_bytes)
        flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0)
        try:
            descriptor = os.open(destination, flags, 0o600)
        except OSError as exc:
            raise AboxProfileCaptureError("cannot materialize bounded profile artifact") from exc
        try:
            with os.fdopen(descriptor, "wb", closefd=False) as stream:
                stream.write(content)
                stream.flush()
        finally:
            os.close(descriptor)

    def __call__(
        self,
        argv: Sequence[str],
        *,
        cwd: Path,
        env: Mapping[str, str],
        timeout: float,
        max_output_chars: int,
    ) -> ProfileProcessResult:
        del cwd
        guest_argv = list(argv)
        guest_argv[0] = _guest_executable(guest_argv[0])
        output = _output_argument(guest_argv)
        host_output: Path | None = None
        if output is not None:
            output_index, host_output = output
            guest_argv[output_index] = _GUEST_OUTPUT_PATH
        declared_environment = self._workload.spec.command.env
        if any(env.get(name) != value for name, value in declared_environment.items()):
            raise AboxProfileCaptureError("capture environment does not match the workload")
        command = self._run_command(guest_argv, declared_environment, timeout)
        result = self._command_executor(
            command,
            timeout=(
                timeout
                + IN_GUEST_SETUP_HEADROOM_SECONDS
                + SUBPROCESS_TIMEOUT_HEADROOM_SECONDS
            ),
            max_output_chars=max_output_chars,
            cancel_event=self._cancel_event,
        )
        timed_out = result.timed_out or result.exit_code == 124
        if result.exit_code == 0 and host_output is not None:
            source = self._worktree() / _GUEST_OUTPUT_PATH.removeprefix("/workspace/")
            self._copy_artifact(source, host_output, self._max_artifact_bytes)
        return ProfileProcessResult(
            result.exit_code,
            stdout=result.stdout,
            stderr=result.stderr,
            timed_out=timed_out,
        )


class AboxProfileCaptureService:
    """Verify, provision, capture, persist, and clean one diagnostic snapshot."""

    def __init__(
        self,
        artifact_store: ArtifactStore,
        *,
        abox_bin: str = "abox",
        command_executor: AboxCommandExecutor = bounded_abox_executor,
        repo_resolver: RepositoryResolver | None = None,
        candidate_patches: Mapping[str, str] | None = None,
        adapter_factory: ProfilerAdapterFactory = _default_adapter_factory,
        scratch_root: Path | None = None,
        limits: CaptureLimits | None = None,
    ) -> None:
        self._artifact_store = artifact_store
        self._abox_bin = abox_bin
        self._command_executor = command_executor
        self._repo_resolver = repo_resolver
        self._candidate_patches = dict(candidate_patches or {})
        self._adapter_factory = adapter_factory
        self._scratch_root = scratch_root
        self._limits = limits or CaptureLimits()

    def _resolve_repo(self, revision: RevisionPin) -> Path:
        if self._repo_resolver is not None:
            resolved = self._repo_resolver(revision.repository)
            if resolved is not None:
                return Path(resolved).expanduser().resolve()
        return _file_uri_path(revision.source_uri)

    @staticmethod
    def _validate_workload(
        workload: LoadedWorkload,
        revision: RevisionPin,
        environment: EnvironmentPin,
        profiler: ProfilerSpec,
    ) -> None:
        report = verify_and_pin_workload(
            workload.root,
            workload.spec,
            source_uri=workload.provenance.source_uri,
            source_kind=workload.provenance.source_kind.value,
            collection_revision=workload.provenance.collection_revision,
            policy=WorkloadVerificationPolicy(
                allow_scoped_network=True,
                allowed_environment_keys=tuple(workload.spec.command.env),
            ),
        )
        if not report.ok or report.pin != workload.pin:
            raise AboxProfileCaptureError("loaded workload bytes do not match their immutable pin")
        if workload.spec.subject.repo != revision.repository:
            raise AboxProfileCaptureError("workload subject does not match the revision repository")
        if profiler not in workload.spec.profilers:
            raise AboxProfileCaptureError("profiler spec is not declared by the pinned workload")
        declared = workload.spec.environment
        if declared.profile != environment.profile:
            raise AboxProfileCaptureError("environment profile does not match the workload")
        if declared.cpu_count is not None and declared.cpu_count != environment.cpu_count:
            raise AboxProfileCaptureError("environment cpu count does not match the workload")
        if declared.memory_mb is not None and declared.memory_mb != environment.memory_mb:
            raise AboxProfileCaptureError("environment memory does not match the workload")

    @staticmethod
    def _validate_revision(repo: Path, revision: RevisionPin) -> None:
        if revision.dirty and revision.patch_digest is None:
            raise AboxProfileCaptureError("dirty persistent revisions cannot be profiled")
        if (
            revision.patch_digest is not None
            and revision.base_commit_sha != revision.commit_sha
        ):
            raise AboxProfileCaptureError("candidate base commit does not match RevisionPin")
        actual = pin_repository_revision(
            repo,
            revision.commit_sha,
            repository=revision.repository,
            require_clean=not revision.dirty,
        )
        if (
            actual.commit_sha != revision.commit_sha
            or actual.tree_digest != revision.tree_digest
        ):
            raise AboxProfileCaptureError("repository revision does not match its immutable pin")

    def _verify_abox(self, environment: EnvironmentPin) -> None:
        result = self._command_executor(
            [self._abox_bin, "--version"],
            timeout=_HOUSEKEEPING_TIMEOUT_SECONDS,
            max_output_chars=_HOUSEKEEPING_OUTPUT_CHARS,
        )
        output = f"{result.stdout} {result.stderr}".strip()
        if result.exit_code != 0 or "abox" not in output.lower():
            raise AboxProfileCaptureError("configured sandbox binary is not verifiably abox")
        version = re.search(r"\d+\.\d+(?:\.\d+)?", output)
        if version is None or version.group(0) != environment.abox_version:
            raise AboxProfileCaptureError("abox runtime version does not match EnvironmentPin")

    def _candidate_ref(
        self,
        repo: Path,
        revision: RevisionPin,
        scratch: Path,
    ) -> tuple[str, Path | None, str | None]:
        if revision.patch_digest is None:
            return revision.commit_sha, None, None
        try:
            patch = self._candidate_patches[revision.patch_digest]
        except KeyError as exc:
            raise AboxProfileCaptureError(
                f"candidate patch bytes unavailable for {revision.patch_digest}"
            ) from exc
        if sha256_text(patch) != revision.patch_digest:
            raise AboxProfileCaptureError("candidate patch bytes do not match RevisionPin")
        if "\x00" in patch:
            raise AboxProfileCaptureError("candidate patch contains a NUL byte")
        worktree = scratch / "candidate"
        branch = f"profile/{ids.run_id()[-12:]}"
        patch_path = scratch / "candidate.patch"
        patch_path.write_text(patch if patch.endswith("\n") else patch + "\n")
        _git(repo, "worktree", "add", "-b", branch, str(worktree), revision.commit_sha)
        try:
            _git(worktree, "apply", "--", str(patch_path))
            _git(worktree, "add", "-A")
            _git(
                worktree,
                "-c",
                "user.email=bakudo@profile",
                "-c",
                "user.name=bakudo-profile",
                "commit",
                "-q",
                "-m",
                "candidate profile",
            )
        except Exception:
            _git(repo, "worktree", "remove", "--force", str(worktree))
            _git(repo, "branch", "-D", branch)
            raise
        return branch, worktree, branch

    @staticmethod
    def _invocation(workload: LoadedWorkload) -> WorkloadInvocation:
        argv: list[str] = []
        for argument in workload.spec.command.argv:
            relative = PurePosixPath(argument)
            is_safe_member = (
                not argument.startswith("-")
                and "\\" not in argument
                and not relative.is_absolute()
                and ".." not in relative.parts
                and "." not in relative.parts
                and relative.as_posix() == argument
            )
            candidate = workload.root / argument
            if is_safe_member and candidate.is_file():
                argv.append(f"{_GUEST_WORKLOAD_ROOT}/{argument}")
            else:
                argv.append(argument)
        return WorkloadInvocation(
            tuple(argv),
            env=tuple(sorted(workload.spec.command.env.items())),
        )

    def _cleanup(
        self,
        task_id: str,
        repo: Path,
        worktree: Path | None,
        branch: str | None,
        scratch: Path,
    ) -> None:
        try:
            self._command_executor(
                [self._abox_bin, "stop", "--clean", task_id, "--repo", str(repo)],
                timeout=_HOUSEKEEPING_TIMEOUT_SECONDS,
                max_output_chars=_HOUSEKEEPING_OUTPUT_CHARS,
            )
        except Exception:  # noqa: BLE001 - primary capture result remains authoritative
            pass
        if worktree is not None:
            try:
                _git(repo, "worktree", "remove", "--force", str(worktree))
            except Exception:
                pass
        if branch is not None:
            try:
                _git(repo, "branch", "-D", branch)
            except Exception:
                pass
        shutil.rmtree(scratch, ignore_errors=True)

    def _verify_snapshot(
        self,
        snapshot: PerformanceSnapshot,
        *,
        snapshot_id: str,
        workload: LoadedWorkload,
        revision: RevisionPin,
        environment: EnvironmentPin,
        profiler: ProfilerSpec,
        adapter: ProfilerAdapter,
    ) -> None:
        expected_environment = environment.model_copy(
            update={
                "profiler_adapter": adapter.descriptor.adapter,
                "profiler_version": adapter.descriptor.version,
            }
        )
        if (
            snapshot.id != snapshot_id
            or snapshot.workload != workload.pin
            or snapshot.revision != revision
            or snapshot.environment != expected_environment
            or snapshot.profiler_spec_digest != canonical_digest(profiler)
        ):
            raise AboxProfileCaptureError("snapshot metadata does not match requested pins")
        for artifact in snapshot.artifacts:
            reference = ArtifactRef(
                uri=artifact.uri,
                digest=artifact.digest,
                media_type=artifact.media_type,
                size_bytes=artifact.byte_size,
                visibility="restricted",
                retention_class="profile",
            )
            content = self._artifact_store.get(reference)
            digest = f"sha256:{hashlib.sha256(content).hexdigest()}"
            if digest != artifact.digest or len(content) != artifact.byte_size:
                raise AboxProfileCaptureError(
                    "stored profile artifact failed integrity verification"
                )

    def capture(
        self,
        workload: LoadedWorkload,
        revision: RevisionPin,
        environment: EnvironmentPin,
        profiler: ProfilerSpec,
        *,
        snapshot_id: str,
        cancel_event: object | None = None,
    ) -> PerformanceSnapshot:
        """Create one fresh-guest diagnostic snapshot at exact immutable pins."""

        if _SNAPSHOT_ID.fullmatch(snapshot_id) is None:
            raise AboxProfileCaptureError("snapshot_id is not a canonical snapshot identifier")
        self._validate_workload(workload, revision, environment, profiler)
        repo = self._resolve_repo(revision)
        self._validate_revision(repo, revision)
        self._verify_abox(environment)
        adapter = self._adapter_factory(profiler)
        if self._scratch_root is not None:
            self._scratch_root.mkdir(parents=True, exist_ok=True)
        scratch = Path(tempfile.mkdtemp(prefix="bakudo-capture-", dir=self._scratch_root))
        task_id = f"capture-{hashlib.sha256(snapshot_id.encode()).hexdigest()[:16]}"
        worktree: Path | None = None
        branch: str | None = None
        try:
            base_ref, worktree, branch = self._candidate_ref(repo, revision, scratch)
            executor = _FreshAboxExecutor(
                abox_bin=self._abox_bin,
                command_executor=self._command_executor,
                repo=repo,
                base_ref=base_ref,
                task_id=task_id,
                workload=workload,
                workload_cwd=workload.spec.command.cwd,
                network=(
                    "scoped"
                    if workload.spec.environment.network.value == "scoped"
                    else "safe"
                ),
                cancel_event=cancel_event,
                max_artifact_bytes=self._limits.max_artifact_bytes,
            )
            runner = AboxProfilerRunner(
                adapter=adapter,
                artifact_store=self._artifact_store,
                executor=executor,
                scratch_root=scratch,
            )
            snapshot = runner.capture(
                ProfileCaptureRequest(
                    idempotency_key=snapshot_id,
                    snapshot_id=snapshot_id,
                    workload=workload.pin,
                    revision=revision,
                    environment=environment,
                    profiler=profiler,
                    workspace=repo,
                    symbol_root="/workspace",
                    invocation=self._invocation(workload),
                    limits=self._limits,
                )
            )
            self._verify_snapshot(
                snapshot,
                snapshot_id=snapshot_id,
                workload=workload,
                revision=revision,
                environment=environment,
                profiler=profiler,
                adapter=adapter,
            )
            return snapshot
        finally:
            self._cleanup(task_id, repo, worktree, branch, scratch)
