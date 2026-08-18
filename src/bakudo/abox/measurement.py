"""Abox-backed, one-invocation performance workload execution.

The runner receives an immutable :class:`LoadedWorkload` and executes its argv
without a shell. A fixed wrapper records wall/process metrics and returns a
bounded JSON marker. Candidate patches are materialized host-side onto a
temporary git branch, but repository code runs only inside the abox guest.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
from collections.abc import Callable, Mapping
from pathlib import Path
from urllib.parse import unquote, urlparse

from .. import ids
from ..performance.models import (
    FailureReason,
    InvocationOutcome,
    InvocationPhase,
    MetricSource,
    MetricValue,
    RecordStatus,
)
from ..performance.pins import EnvironmentPin, RevisionPin
from ..performance.revisions import sha256_text
from ..performance.source import LoadedWorkload
from ..performance.verify import iter_workload_files
from .runner import (
    IN_GUEST_SETUP_HEADROOM_SECONDS,
    SUBPROCESS_TIMEOUT_HEADROOM_SECONDS,
    ExecResult,
    Executor,
    _subprocess_executor,
)

_MARKER = "bakudo_measurement"
_MAX_OUTPUT_CHARS = 20_000

# Where the in-guest wrapper reconstructs the staged workload layout. abox
# stages inputs flat (guest names may not contain "/"), so nested member
# paths are rebuilt here before the workload argv executes.
_GUEST_WORKLOAD_ROOT = "/tmp/bakudo-workload"

_WRAPPER = r"""
import json, os, resource, shutil, subprocess, sys, time

payload = json.loads(sys.argv[1])
inputs_dir = os.environ.get("ABOX_INPUT_DIR", "/abox-meta/inputs")
for flat_name, relative in payload["files"].items():
    destination = os.path.join(payload["workload_root"], relative)
    os.makedirs(os.path.dirname(destination), exist_ok=True)
    shutil.copyfile(os.path.join(inputs_dir, flat_name), destination)
env = os.environ.copy()
env.update(payload["env"])
started_usage = resource.getrusage(resource.RUSAGE_CHILDREN)
started = time.perf_counter()
try:
    proc = subprocess.run(
        payload["argv"], cwd=payload["cwd"], env=env,
        capture_output=True, text=True, timeout=payload["timeout"], shell=False,
    )
    timed_out = False
except subprocess.TimeoutExpired as exc:
    proc = None
    timed_out = True
    stdout = exc.stdout or ""
    stderr = exc.stderr or ""
    if isinstance(stdout, bytes): stdout = stdout.decode(errors="replace")
    if isinstance(stderr, bytes): stderr = stderr.decode(errors="replace")
except FileNotFoundError as exc:
    # Missing interpreter/executable in the guest image: report the shell's
    # command-not-found code through the marker instead of crashing unmarked.
    proc = None
    timed_out = False
    stdout = ""
    stderr = f"workload argv[0] not found in guest: {exc}"
elapsed = time.perf_counter() - started
ended_usage = resource.getrusage(resource.RUSAGE_CHILDREN)
if proc is not None:
    stdout, stderr, exit_code = proc.stdout, proc.stderr, proc.returncode
else:
    exit_code = 124 if timed_out else 127
metrics = {
    "latency_seconds": elapsed,
    "cpu_seconds": max(0.0, (ended_usage.ru_utime + ended_usage.ru_stime)
                        - (started_usage.ru_utime + started_usage.ru_stime)),
    "peak_rss_bytes": int(ended_usage.ru_maxrss) * 1024,
}
for line in reversed(stdout.splitlines()):
    if not line.lstrip().startswith("{"): continue
    try: emitted = json.loads(line)
    except json.JSONDecodeError: continue
    if isinstance(emitted, dict):
        for key, value in emitted.items():
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                metrics[key] = float(value)
        break
print(json.dumps({"bakudo_measurement": {
    "elapsed": elapsed, "exit_code": exit_code, "timed_out": timed_out,
    "metrics": metrics, "stdout": stdout[-20000:], "stderr": stderr[-20000:]
}}))
"""


class AboxMeasurementError(RuntimeError):
    """A trusted measurement runner failure."""


# Bounded diagnostic tail persisted on failed invocations (InvocationOutcome
# caps failureDetail at 2000 characters).
_DETAIL_CHARS = 2_000


def _failure_detail(stderr: str, stdout: str) -> str | None:
    """The most useful bounded tail for a failed invocation, if any."""
    text = (stderr or "").strip() or (stdout or "").strip()
    return text[-_DETAIL_CHARS:] if text else None


def _git(repo: Path, *args: str) -> None:
    result = subprocess.run(
        ["git", "-C", str(repo), *args],
        capture_output=True,
        text=True,
        timeout=120,
    )
    if result.returncode != 0:
        raise AboxMeasurementError(
            f"git {args[0]} failed: {(result.stderr or result.stdout)[-1_000:]}"
        )


def _source_path(uri: str) -> Path:
    parsed = urlparse(uri)
    if parsed.scheme != "file":
        raise AboxMeasurementError(
            f"revision source must be a registered checkout or file URI, got {uri!r}"
        )
    return Path(unquote(parsed.path)).resolve()


def _parse_marker(stdout: str) -> dict[str, object]:
    for line in reversed(stdout.splitlines()):
        if not line.lstrip().startswith("{"):
            continue
        try:
            document = json.loads(line)
        except json.JSONDecodeError:
            continue
        payload = document.get(_MARKER) if isinstance(document, dict) else None
        if isinstance(payload, dict):
            return payload
    raise AboxMeasurementError("measurement guest returned no trusted JSON marker")


class AboxWorkloadInvoker:
    """Execute one warmup or measured invocation in a fresh abox guest."""

    def __init__(
        self,
        *,
        abox_bin: str = "abox",
        executor: Executor | None = None,
        repo_resolver: Callable[[str], Path | str | None] | None = None,
        candidate_patches: Mapping[str, str] | None = None,
        scratch_root: Path | None = None,
    ) -> None:
        self._abox_bin = abox_bin
        self._executor = executor or _subprocess_executor
        self._repo_resolver = repo_resolver
        self._candidate_patches = dict(candidate_patches or {})
        self._scratch_root = scratch_root

    def resolve_repo(self, revision: RevisionPin) -> Path:
        if self._repo_resolver is not None:
            resolved = self._repo_resolver(revision.repository)
            if resolved is not None:
                return Path(resolved).expanduser().resolve()
        return _source_path(revision.source_uri)

    @staticmethod
    def _guest_argv(workload: LoadedWorkload) -> list[str]:
        argv: list[str] = []
        for argument in workload.spec.command.argv:
            candidate = workload.root / argument
            if not argument.startswith("-") and candidate.is_file():
                argv.append(f"{_GUEST_WORKLOAD_ROOT}/{argument}")
            else:
                argv.append(argument)
        return argv

    @staticmethod
    def _staged_files(workload: LoadedWorkload) -> list[tuple[str, Path, str]]:
        """(flat guest name, host path, relative path) for every pinned member.

        abox rejects guest names containing "/" ("must be a plain file
        name"), so members are staged flat under unique names and the
        in-guest wrapper reconstructs the layout at ``workload_root``.
        """
        return [
            (f"w{index}-{path.name}", path, path.relative_to(workload.root).as_posix())
            for index, path in enumerate(iter_workload_files(workload.root))
        ]

    def build_command(
        self,
        workload: LoadedWorkload,
        revision: RevisionPin,
        *,
        task_id: str,
        base_ref: str,
        scratch: Path,
    ) -> list[str]:
        network = "scoped" if workload.spec.environment.network.value == "scoped" else "safe"
        cwd_suffix = "" if workload.spec.command.cwd == "." else f"/{workload.spec.command.cwd}"
        staged = self._staged_files(workload)
        payload = json.dumps(
            {
                "argv": self._guest_argv(workload),
                "cwd": f"/workspace{cwd_suffix}",
                "env": workload.spec.command.env,
                "timeout": workload.spec.measurement.timeout_seconds,
                "files": {flat: relative for flat, _, relative in staged},
                "workload_root": _GUEST_WORKLOAD_ROOT,
            },
            separators=(",", ":"),
        )
        guest_timeout = int(workload.spec.measurement.timeout_seconds) + (
            IN_GUEST_SETUP_HEADROOM_SECONDS
        )
        argv = [
            self._abox_bin,
            "run",
            "--repo",
            str(self.resolve_repo(revision)),
            "--task",
            task_id,
            "--base",
            base_ref,
            "--timeout",
            str(guest_timeout),
            "--network",
            network,
        ]
        for flat, path, _ in staged:
            argv += ["--input-file", f"{path}:{flat}"]
        guest_script = (
            "set -e; "
            "[ ! -f /workspace/.abox/prepare.sh ] || sh /workspace/.abox/prepare.sh >&2; "
            'exec python3 -c "$1" "$2"'
        )
        argv += ["--", "sh", "-c", guest_script, "sh", _WRAPPER, payload]
        return argv

    def _candidate_ref(
        self, repo: Path, revision: RevisionPin, scratch: Path
    ) -> tuple[str, Path | None]:
        if revision.patch_digest is None:
            return revision.commit_sha, None
        try:
            patch = self._candidate_patches[revision.patch_digest]
        except KeyError as exc:
            raise AboxMeasurementError(
                f"candidate patch bytes unavailable for {revision.patch_digest}"
            ) from exc
        if sha256_text(patch) != revision.patch_digest:
            raise AboxMeasurementError(
                "candidate patch bytes do not match the pinned patch digest"
            )
        if "\x00" in patch:
            raise AboxMeasurementError("candidate patch contains a NUL byte")
        worktree = scratch / "candidate"
        branch = f"measure/{ids.run_id()[-12:]}"
        patch_path = scratch / "candidate.patch"
        patch_path.write_text(patch if patch.endswith("\n") else patch + "\n")
        _git(repo, "worktree", "add", "-b", branch, str(worktree), revision.commit_sha)
        try:
            _git(worktree, "apply", "--", str(patch_path))
            _git(worktree, "add", "-A")
            _git(
                worktree,
                "-c",
                "user.email=bakudo@measurement",
                "-c",
                "user.name=bakudo-measurement",
                "commit",
                "-q",
                "-m",
                "candidate measurement",
            )
        except Exception:
            _git(repo, "worktree", "remove", "--force", str(worktree))
            _git(repo, "branch", "-D", branch)
            raise
        return branch, worktree

    def invoke(
        self,
        workload: LoadedWorkload,
        revision: RevisionPin,
        environment: EnvironmentPin,
        *,
        phase: InvocationPhase,
        ordinal: int,
    ) -> InvocationOutcome:
        del environment  # equality/compatibility is enforced by the service
        if self._scratch_root is not None:
            self._scratch_root.mkdir(parents=True, exist_ok=True)
        scratch = Path(tempfile.mkdtemp(prefix="bakudo-measure-", dir=self._scratch_root))
        repo = self.resolve_repo(revision)
        task_id = f"measure-{ids.run_id()[-12:]}"
        worktree: Path | None = None
        branch: str | None = None
        try:
            base_ref, worktree = self._candidate_ref(repo, revision, scratch)
            branch = base_ref if worktree is not None else None
            argv = self.build_command(
                workload,
                revision,
                task_id=task_id,
                base_ref=base_ref,
                scratch=scratch,
            )
            timeout = (
                workload.spec.measurement.timeout_seconds
                + IN_GUEST_SETUP_HEADROOM_SECONDS
                + SUBPROCESS_TIMEOUT_HEADROOM_SECONDS
            )
            try:
                result: ExecResult = self._executor(argv, timeout)
            except FileNotFoundError as exc:
                raise AboxMeasurementError(f"abox binary not found: {self._abox_bin}") from exc
            if result.exit_code != 0:
                return InvocationOutcome(
                    ordinal=ordinal,
                    phase=phase,
                    status=RecordStatus.timed_out
                    if result.timed_out or result.exit_code == 124
                    else RecordStatus.failed,
                    exit_code=result.exit_code,
                    failure_reason=FailureReason.timeout
                    if result.timed_out or result.exit_code == 124
                    else FailureReason.infrastructure,
                    failure_detail=_failure_detail(result.stderr, result.stdout),
                )
            payload = _parse_marker(result.stdout)
            timed_out = bool(payload.get("timed_out"))
            raw_exit_code = payload.get("exit_code", 1)
            if isinstance(raw_exit_code, bool) or not isinstance(raw_exit_code, (int, float)):
                raise AboxMeasurementError("measurement marker exit_code is malformed")
            exit_code = int(raw_exit_code)
            raw_metrics = payload.get("metrics")
            if not isinstance(raw_metrics, dict):
                raise AboxMeasurementError("measurement marker metrics are malformed")
            declared = {
                definition.name: definition
                for definition in workload.spec.measurement.metrics
            }
            metrics: list[MetricValue] = []
            for name, definition in declared.items():
                if definition.source not in {
                    MetricSource.wall_clock,
                    MetricSource.process,
                    MetricSource.workload,
                }:
                    continue
                value = raw_metrics.get(name)
                if isinstance(value, (int, float)) and not isinstance(value, bool):
                    metrics.append(MetricValue(name=name, unit=definition.unit, value=float(value)))
            completed = not timed_out and exit_code == 0
            raw_elapsed = payload.get("elapsed", 0.0)
            if isinstance(raw_elapsed, bool) or not isinstance(raw_elapsed, (int, float)):
                raise AboxMeasurementError("measurement marker elapsed is malformed")
            return InvocationOutcome(
                ordinal=ordinal,
                phase=phase,
                status=RecordStatus.completed
                if completed
                else (RecordStatus.timed_out if timed_out else RecordStatus.failed),
                elapsed_seconds=float(raw_elapsed),
                exit_code=exit_code,
                metrics=tuple(metrics),
                failure_reason=None
                if completed
                else (FailureReason.timeout if timed_out else FailureReason.workload),
                failure_detail=None
                if completed
                else _failure_detail(
                    str(payload.get("stderr", "")), str(payload.get("stdout", ""))
                ),
            )
        finally:
            try:
                self._executor(
                    [self._abox_bin, "stop", "--clean", task_id, "--repo", str(repo)], 120
                )
            except Exception:  # noqa: BLE001 - best-effort guest cleanup
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
