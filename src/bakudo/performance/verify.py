"""Pure workload-input verification and canonical content digests."""

from __future__ import annotations

import hashlib
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Literal

from .models import (
    ExtensionValue,
    MetricSource,
    NetworkPolicy,
    WorkloadSpec,
    canonical_digest,
)
from .pins import FileDigest, WorkloadPin

MAX_WORKLOAD_FILES = 2_048
MAX_WORKLOAD_FILE_BYTES = 16 * 1024 * 1024
MAX_WORKLOAD_TOTAL_BYTES = 64 * 1024 * 1024
DEFAULT_ALLOWED_ENVIRONMENT_KEYS = ("LANG", "LC_ALL", "PYTHONHASHSEED", "TZ")


class WorkloadVerificationError(ValueError):
    """Raised when trusted workload inputs fail closed."""


@dataclass(frozen=True)
class WorkloadVerificationPolicy:
    """The sandbox posture a manifest is allowed to tighten, never widen."""

    selected_profile: str | None = None
    allow_scoped_network: bool = False
    max_cpu_count: int | None = None
    max_memory_mb: int | None = None
    supported_metric_sources: tuple[MetricSource, ...] = tuple(MetricSource)
    supported_profilers: tuple[str, ...] | None = None
    allowed_environment_keys: tuple[str, ...] = DEFAULT_ALLOWED_ENVIRONMENT_KEYS
    profiler_option_validators: Mapping[
        str, Callable[[dict[str, ExtensionValue]], None]
    ] | None = None


@dataclass(frozen=True)
class VerificationIssue:
    path: str
    message: str


@dataclass(frozen=True)
class WorkloadVerificationReport:
    ok: bool
    issues: tuple[VerificationIssue, ...]
    pin: WorkloadPin | None = None


def safe_relative_path(value: str) -> PurePosixPath:
    if not value or "\\" in value:
        raise WorkloadVerificationError(f"unsafe workload path {value!r}")
    path = PurePosixPath(value)
    if path.is_absolute() or ".." in path.parts or "." in path.parts:
        raise WorkloadVerificationError(f"unsafe workload path {value!r}")
    if path.as_posix() != value:
        raise WorkloadVerificationError(f"workload path is not normalized: {value!r}")
    return path


def resolve_member(root: Path, relative: str) -> Path:
    path = safe_relative_path(relative)
    candidate = root.joinpath(*path.parts)
    try:
        candidate.resolve().relative_to(root.resolve())
    except (OSError, ValueError) as exc:
        raise WorkloadVerificationError(f"workload member escapes its root: {relative!r}") from exc
    if candidate.is_symlink():
        raise WorkloadVerificationError(f"workload member may not be a symlink: {relative!r}")
    if not candidate.is_file():
        raise WorkloadVerificationError(f"workload member does not exist: {relative!r}")
    return candidate


def sha256_bytes(data: bytes) -> str:
    return f"sha256:{hashlib.sha256(data).hexdigest()}"


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


# Installer byte-compilation caches are not workload content: pip compiles
# packaged corpora on install, so including them would make a wheel install's
# content digest diverge from the source checkout that pinned the workload.
_BYTECODE_CACHE_DIR = "__pycache__"
_BYTECODE_SUFFIXES = frozenset({".pyc", ".pyo"})


def iter_workload_files(root: Path) -> tuple[Path, ...]:
    if not root.is_dir():
        raise WorkloadVerificationError(f"workload root does not exist: {root}")
    files: list[Path] = []
    total = 0
    for path in sorted(root.rglob("*"), key=lambda item: item.relative_to(root).as_posix()):
        if path.is_symlink():
            raise WorkloadVerificationError(
                f"workload may not contain symlinks: {path.relative_to(root).as_posix()!r}"
            )
        relative = path.relative_to(root)
        if _BYTECODE_CACHE_DIR in relative.parts or relative.suffix in _BYTECODE_SUFFIXES:
            continue
        if not path.is_file():
            continue
        size = path.stat().st_size
        if size > MAX_WORKLOAD_FILE_BYTES:
            raise WorkloadVerificationError(
                f"workload member exceeds {MAX_WORKLOAD_FILE_BYTES} bytes: "
                f"{path.relative_to(root).as_posix()!r}"
            )
        total += size
        if total > MAX_WORKLOAD_TOTAL_BYTES:
            raise WorkloadVerificationError(
                f"workload exceeds {MAX_WORKLOAD_TOTAL_BYTES} total bytes"
            )
        files.append(path)
        if len(files) > MAX_WORKLOAD_FILES:
            raise WorkloadVerificationError(
                f"workload exceeds the {MAX_WORKLOAD_FILES} file limit"
            )
    return tuple(files)


def workload_content_digest(root: Path) -> str:
    """Digest every workload byte together with its normalized relative path."""

    digest = hashlib.sha256()
    for path in iter_workload_files(root):
        relative = path.relative_to(root).as_posix()
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\1")
    return f"sha256:{digest.hexdigest()}"


def _referenced_executor_paths(root: Path, spec: WorkloadSpec) -> tuple[str, ...]:
    paths: list[str] = []
    for argument in spec.command.argv:
        if argument.startswith("-"):
            continue
        try:
            relative = safe_relative_path(argument)
        except WorkloadVerificationError:
            continue
        candidate = root.joinpath(*relative.parts)
        if candidate.is_file():
            resolve_member(root, argument)
            paths.append(argument)
        elif relative.suffix in {".js", ".py", ".rb", ".sh", ".ts"}:
            raise WorkloadVerificationError(
                f"referenced command member does not exist: {argument!r}"
            )
    return tuple(sorted(set(paths)))


def _file_digests(root: Path, paths: Iterable[str]) -> tuple[FileDigest, ...]:
    return tuple(
        FileDigest(path=relative, digest=sha256_file(resolve_member(root, relative)))
        for relative in sorted(set(paths))
    )


def _policy_issues(
    spec: WorkloadSpec, policy: WorkloadVerificationPolicy
) -> tuple[VerificationIssue, ...]:
    issues: list[VerificationIssue] = []
    environment = spec.environment
    if policy.selected_profile is not None and environment.profile != policy.selected_profile:
        issues.append(
            VerificationIssue(
                "/environment/profile",
                f"{environment.profile!r} does not match selected profile "
                f"{policy.selected_profile!r}",
            )
        )
    if environment.network is NetworkPolicy.scoped and not policy.allow_scoped_network:
        issues.append(
            VerificationIssue(
                "/environment/network", "scoped network would widen the selected sandbox posture"
            )
        )
    if (
        policy.max_cpu_count is not None
        and environment.cpu_count is not None
        and environment.cpu_count > policy.max_cpu_count
    ):
        issues.append(
            VerificationIssue(
                "/environment/cpuCount",
                f"requests {environment.cpu_count}; policy allows {policy.max_cpu_count}",
            )
        )
    if (
        policy.max_memory_mb is not None
        and environment.memory_mb is not None
        and environment.memory_mb > policy.max_memory_mb
    ):
        issues.append(
            VerificationIssue(
                "/environment/memoryMb",
                f"requests {environment.memory_mb}; policy allows {policy.max_memory_mb}",
            )
        )
    supported_sources = set(policy.supported_metric_sources)
    allowed_environment_keys = set(policy.allowed_environment_keys)
    for name in sorted(spec.command.env):
        if name not in allowed_environment_keys:
            issues.append(
                VerificationIssue(
                    f"/command/env/{name}",
                    "environment variable is not allowlisted by the measurement policy",
                )
            )
    for index, metric in enumerate(spec.measurement.metrics):
        if metric.source not in supported_sources:
            issues.append(
                VerificationIssue(
                    f"/measurement/metrics/{index}/source",
                    f"metric source {metric.source.value!r} is unsupported",
                )
            )
    if policy.supported_profilers is not None:
        supported_profilers = set(policy.supported_profilers)
        for index, profiler in enumerate(spec.profilers):
            if profiler.adapter not in supported_profilers:
                issues.append(
                    VerificationIssue(
                        f"/profilers/{index}/adapter",
                        f"profiler adapter {profiler.adapter!r} is unsupported",
                    )
                )
    if policy.profiler_option_validators is not None:
        for index, profiler in enumerate(spec.profilers):
            validator = policy.profiler_option_validators.get(profiler.adapter)
            if validator is None:
                continue
            try:
                validator(profiler.options)
            except (TypeError, ValueError) as exc:
                issues.append(
                    VerificationIssue(
                        f"/profilers/{index}/options",
                        f"invalid options for {profiler.adapter!r}: {exc}",
                    )
                )
    return tuple(issues)


def verify_and_pin_workload(
    root: Path,
    spec: WorkloadSpec,
    *,
    source_uri: str,
    source_kind: Literal["directory", "repository", "bundle"],
    collection_revision: str,
    policy: WorkloadVerificationPolicy | None = None,
) -> WorkloadVerificationReport:
    issues = list(_policy_issues(spec, policy or WorkloadVerificationPolicy()))
    try:
        iter_workload_files(root)
        dataset_paths: tuple[str, ...] = ()
        if spec.dataset is not None:
            dataset_paths = (spec.dataset.path,)
            actual = sha256_file(resolve_member(root, spec.dataset.path))
            if actual != spec.dataset.digest:
                issues.append(
                    VerificationIssue(
                        "/dataset/digest",
                        f"declared {spec.dataset.digest}; actual {actual}",
                    )
                )
        executor_paths = _referenced_executor_paths(root, spec)
        pin = WorkloadPin(
            source_uri=source_uri,
            source_kind=source_kind,
            collection_revision=collection_revision,
            name=spec.metadata.name,
            version=spec.metadata.version,
            manifest_digest=canonical_digest(spec),
            dataset_digests=_file_digests(root, dataset_paths),
            executor_digests=_file_digests(root, executor_paths),
            bundle_digest=workload_content_digest(root),
        )
    except (OSError, WorkloadVerificationError) as exc:
        issues.append(VerificationIssue("/", str(exc)))
        pin = None
    return WorkloadVerificationReport(not issues, tuple(issues), pin if not issues else None)
