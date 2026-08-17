"""Task sources, canonical digests, and corpus immutability checks."""

from __future__ import annotations

import hashlib
import json
import os
from collections.abc import Sequence
from pathlib import Path
from typing import Literal, Protocol
from urllib.parse import unquote, urlparse

import yaml
from pydantic import BaseModel, ConfigDict, Field, PrivateAttr

from ..schema import validate_task_spec
from .models import TaskPin, TaskSpec


class TaskLoadError(ValueError):
    """Raised when a task or task-source manifest is invalid."""


class CorpusManifest(BaseModel):
    """Identity of a versioned task corpus checkout."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    api_version: Literal["bakudo.ai/v1alpha1"] = Field(
        default="bakudo.ai/v1alpha1", alias="apiVersion"
    )
    kind: Literal["TaskCorpus"] = "TaskCorpus"
    name: str
    revision: str
    source_uri: str | None = Field(default=None, alias="sourceURI")


def load_task(task_dir: Path) -> TaskSpec:
    task_file = task_dir / "task.yaml"
    try:
        data = yaml.safe_load(task_file.read_text())
    except OSError as exc:
        raise TaskLoadError(f"{task_file}: {exc}") from exc
    except yaml.YAMLError as exc:
        raise TaskLoadError(f"{task_file}: invalid YAML: {exc}") from exc

    try:
        validate_task_spec(data)
        return TaskSpec.model_validate(data)
    except Exception as exc:
        raise TaskLoadError(f"{task_file}: {exc}") from exc


def _hash_files(root: Path, files: Sequence[Path]) -> str:
    digest = hashlib.sha256()
    for path in sorted(files, key=lambda item: item.relative_to(root).as_posix()):
        relative = path.relative_to(root).as_posix()
        digest.update(relative.encode())
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\1")
    return f"sha256:{digest.hexdigest()}"


def task_bundle_digest(task_dir: Path) -> str:
    """Canonical digest of every file in a task bundle."""

    return _hash_files(task_dir, [path for path in task_dir.rglob("*") if path.is_file()])


def _safe_member(task_dir: Path, relative: str) -> Path:
    candidate = (task_dir / relative).resolve()
    try:
        candidate.relative_to(task_dir.resolve())
    except ValueError as exc:
        raise TaskLoadError(f"task member escapes its bundle: {relative!r}") from exc
    if not candidate.is_file():
        raise TaskLoadError(f"task member does not exist: {relative!r}")
    return candidate


def task_verifier_digest(task_dir: Path, spec: TaskSpec) -> str:
    """Digest only the privileged reward and constraint definition.

    Instruction or fixture edits change the bundle digest without changing
    this digest. Changes to verifier configuration, verifier inputs, or
    negative controls change both.
    """

    config = json.dumps(
        {
            "verifier": spec.verifier.model_dump(by_alias=True, mode="json"),
            "constraints": spec.constraints.model_dump(by_alias=True, mode="json"),
        },
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    digest = hashlib.sha256()
    digest.update(b"verifier-config\0")
    digest.update(config)
    digest.update(b"\1")
    members = {
        *spec.verifier.fail_to_pass,
        *spec.verifier.pass_to_pass,
        *spec.verifier.negative_controls,
    }
    for relative in sorted(members):
        path = _safe_member(task_dir, relative)
        digest.update(relative.encode())
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\1")
    return f"sha256:{digest.hexdigest()}"


class LoadedTask(BaseModel):
    """A validated task plus the immutable identity used to load it."""

    model_config = ConfigDict(arbitrary_types_allowed=True, frozen=True)

    spec: TaskSpec
    path: Path
    pin: TaskPin
    # Archive-backed tasks retain their TemporaryDirectory through this
    # private owner. It is deliberately excluded from validation and
    # serialization: materialization lifetime is a loader concern, not part
    # of task identity.
    _materialization_owner: object | None = PrivateAttr(default=None)

    @property
    def ref(self) -> str:
        return self.spec.ref


class TaskSource(Protocol):
    """Runtime source of versioned task bundles."""

    @property
    def source_uri(self) -> str: ...

    @property
    def corpus_revision(self) -> str: ...

    def list(
        self,
        family: str | None = None,
        partitions: Sequence[str] | None = None,
        tags: Sequence[str] | None = None,
    ) -> list[LoadedTask]: ...

    def get(self, name: str) -> LoadedTask: ...


class DirectoryTaskSource:
    """Discover task bundles under a versioned corpus directory."""

    def __init__(
        self,
        root: Path,
        *,
        source_uri: str | None = None,
        corpus_revision: str | None = None,
    ) -> None:
        self.root = root.resolve()
        self.task_root = self.root / "tasks" if (self.root / "tasks").is_dir() else self.root
        manifest = self._load_manifest()
        self._source_uri = (
            source_uri or (manifest.source_uri if manifest else None) or self.root.as_uri()
        )
        self._corpus_revision = corpus_revision or (
            manifest.revision if manifest else "unversioned"
        )
        self._tasks: dict[str, LoadedTask] = {}
        self._discover()

    @property
    def source_uri(self) -> str:
        return self._source_uri

    @property
    def corpus_revision(self) -> str:
        return self._corpus_revision

    def _load_manifest(self) -> CorpusManifest | None:
        path = self.root / "corpus.yaml"
        if not path.is_file():
            return None
        try:
            return CorpusManifest.model_validate(yaml.safe_load(path.read_text()))
        except Exception as exc:
            raise TaskLoadError(f"{path}: {exc}") from exc

    def _discover(self) -> None:
        if not self.task_root.is_dir():
            return
        for child in sorted(self.task_root.iterdir()):
            if not child.is_dir() or not (child / "task.yaml").is_file():
                continue
            spec = load_task(child)
            pin = TaskPin(
                source_uri=self.source_uri,
                corpus_revision=self.corpus_revision,
                name=spec.metadata.name,
                version=spec.metadata.version,
                bundle_digest=task_bundle_digest(child),
                verifier_digest=task_verifier_digest(child, spec),
            )
            loaded = LoadedTask(spec=spec, path=child, pin=pin)
            if loaded.ref in self._tasks:
                raise TaskLoadError(f"duplicate task ref {loaded.ref!r} in {self.root}")
            self._tasks[loaded.ref] = loaded

    def list(
        self,
        family: str | None = None,
        partitions: Sequence[str] | None = None,
        tags: Sequence[str] | None = None,
    ) -> list[LoadedTask]:
        results = list(self._tasks.values())
        if family is not None:
            results = [task for task in results if task.spec.metadata.family.value == family]
        if partitions is not None:
            allowed = set(partitions)
            results = [task for task in results if task.spec.metadata.partition.value in allowed]
        if tags is not None:
            required = set(tags)
            results = [task for task in results if required & set(task.spec.metadata.tags)]
        return results

    def get(self, name: str) -> LoadedTask:
        if name in self._tasks:
            return self._tasks[name]
        matches = [task for task in self._tasks.values() if task.spec.metadata.name == name]
        if len(matches) == 1:
            return matches[0]
        known = ", ".join(sorted(self._tasks)) or "<none>"
        if len(matches) > 1:
            refs = ", ".join(sorted(task.ref for task in matches))
            raise KeyError(f"Ambiguous task name {name!r} matches {refs}; use name@version.")
        raise KeyError(f"Unknown task ref: {name!r}. Known refs: {known}") from None


def _local_source_path(value: str) -> Path:
    parsed = urlparse(value)
    if parsed.scheme == "file":
        return Path(unquote(parsed.path))
    if parsed.scheme:
        raise ValueError(
            f"unsupported task source URI scheme {parsed.scheme!r}; "
            "fetch remote artifacts into a local content-addressed cache first"
        )
    return Path(value)


def default_task_source() -> TaskSource:
    """Resolve ``BAKUDO_TASK_SOURCE`` or fall back to the bundled smoke corpus."""

    configured = os.environ.get("BAKUDO_TASK_SOURCE")
    if configured:
        path = _local_source_path(configured).expanduser().resolve()
        if path.is_dir():
            return DirectoryTaskSource(path)
        from .bundle import ArchiveTaskSource

        return ArchiveTaskSource(path)

    from ..paths import smoke_tasks_dir

    return DirectoryTaskSource(smoke_tasks_dir())


def check_immutability(source: TaskSource, lockfile: Path) -> list[str]:
    if not lockfile.is_file():
        return []
    locked: dict[str, str] = json.loads(lockfile.read_text())
    live = {task.ref: task.pin.bundle_digest for task in source.list()}
    return [
        f"{ref}: bundle digest changed ({digest} -> {live[ref]}) without a version bump"
        for ref, digest in locked.items()
        if ref in live and live[ref] != digest
    ]


def update_lock(source: TaskSource, lockfile: Path) -> None:
    data = {task.ref: task.pin.bundle_digest for task in source.list()}
    lockfile.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")
