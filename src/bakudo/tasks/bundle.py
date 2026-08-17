"""Deterministic publication and loading of content-addressed task bundles."""

from __future__ import annotations

import io
import json
import tarfile
import tempfile
from collections.abc import Sequence
from pathlib import Path, PurePosixPath
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from .source import DirectoryTaskSource, LoadedTask, TaskLoadError


class BundleManifest(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    api_version: str = Field(default="bakudo.ai/v1alpha1", alias="apiVersion")
    kind: Literal["TaskBundle"] = "TaskBundle"
    corpus_uri: str = Field(alias="corpusURI")
    corpus_revision: str = Field(alias="corpusRevision")
    task_name: str = Field(alias="taskName")
    task_version: int = Field(alias="taskVersion", ge=1)
    bundle_digest: str = Field(alias="bundleDigest")
    verifier_digest: str = Field(alias="verifierDigest")

    def to_dict(self) -> dict[str, object]:
        return self.model_dump(by_alias=True, mode="json")


def _tar_info(name: str, size: int, *, mode: int = 0o644) -> tarfile.TarInfo:
    info = tarfile.TarInfo(name)
    info.size = size
    info.mode = mode
    info.mtime = 0
    info.uid = 0
    info.gid = 0
    info.uname = ""
    info.gname = ""
    return info


def publish_bundle(task: LoadedTask, output_dir: Path) -> Path:
    """Publish ``task`` as ``<sha256>.tar`` and return the artifact path."""

    output_dir.mkdir(parents=True, exist_ok=True)
    digest_hex = task.pin.bundle_digest.removeprefix("sha256:")
    artifact = output_dir / f"{digest_hex}.tar"
    manifest = BundleManifest(
        corpus_uri=task.pin.source_uri,
        corpus_revision=task.pin.corpus_revision,
        task_name=task.pin.name,
        task_version=task.pin.version,
        bundle_digest=task.pin.bundle_digest,
        verifier_digest=task.pin.verifier_digest,
    )
    manifest_bytes = (json.dumps(manifest.to_dict(), indent=2, sort_keys=True) + "\n").encode()

    with tarfile.open(artifact, "w", format=tarfile.USTAR_FORMAT) as archive:
        archive.addfile(_tar_info("bundle.json", len(manifest_bytes)), io.BytesIO(manifest_bytes))
        for path in sorted(
            (item for item in task.path.rglob("*") if item.is_file()),
            key=lambda item: item.relative_to(task.path).as_posix(),
        ):
            relative = path.relative_to(task.path).as_posix()
            data = path.read_bytes()
            archive.addfile(_tar_info(f"task/{relative}", len(data)), io.BytesIO(data))
    return artifact


def _safe_archive_name(name: str) -> PurePosixPath:
    path = PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts:
        raise TaskLoadError(f"unsafe task bundle member: {name!r}")
    return path


def extract_bundle(artifact: Path, destination: Path) -> tuple[BundleManifest, Path]:
    """Validate and extract a published bundle into ``destination``."""

    destination.mkdir(parents=True, exist_ok=True)
    task_root = destination / "task"
    manifest: BundleManifest | None = None
    with tarfile.open(artifact, "r") as archive:
        for member in archive.getmembers():
            relative = _safe_archive_name(member.name)
            if not member.isfile():
                continue
            stream = archive.extractfile(member)
            if stream is None:
                raise TaskLoadError(f"could not read task bundle member {member.name!r}")
            data = stream.read()
            if relative == PurePosixPath("bundle.json"):
                manifest = BundleManifest.model_validate_json(data)
                continue
            if not relative.parts or relative.parts[0] != "task":
                raise TaskLoadError(f"unexpected task bundle member: {member.name!r}")
            target = destination.joinpath(*relative.parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)

    if manifest is None:
        raise TaskLoadError(f"{artifact}: missing bundle.json")
    source = DirectoryTaskSource(
        destination,
        source_uri=artifact.resolve().as_uri(),
        corpus_revision=manifest.corpus_revision,
    )
    tasks = source.list()
    if len(tasks) != 1:
        raise TaskLoadError(f"{artifact}: expected exactly one task, found {len(tasks)}")
    loaded = tasks[0]
    if loaded.pin.bundle_digest != manifest.bundle_digest:
        raise TaskLoadError(
            f"{artifact}: bundle digest mismatch "
            f"({manifest.bundle_digest} != {loaded.pin.bundle_digest})"
        )
    if loaded.pin.verifier_digest != manifest.verifier_digest:
        raise TaskLoadError(
            f"{artifact}: verifier digest mismatch "
            f"({manifest.verifier_digest} != {loaded.pin.verifier_digest})"
        )
    if loaded.pin.name != manifest.task_name or loaded.pin.version != manifest.task_version:
        raise TaskLoadError(f"{artifact}: task identity does not match bundle manifest")
    return manifest, task_root


class ArchiveTaskSource:
    """A runtime source backed by one locally cached published bundle."""

    def __init__(self, artifact: Path) -> None:
        self._temporary = tempfile.TemporaryDirectory(prefix="bakudo-task-bundle-")
        root = Path(self._temporary.name)
        manifest, _task_root = extract_bundle(artifact.resolve(), root)
        self._source = DirectoryTaskSource(
            root,
            source_uri=artifact.resolve().as_uri(),
            corpus_revision=manifest.corpus_revision,
        )
        for task in self._source.list():
            task._materialization_owner = self._temporary

    @property
    def source_uri(self) -> str:
        return self._source.source_uri

    @property
    def corpus_revision(self) -> str:
        return self._source.corpus_revision

    def list(
        self,
        family: str | None = None,
        partitions: Sequence[str] | None = None,
        tags: Sequence[str] | None = None,
    ) -> list[LoadedTask]:
        return self._source.list(family=family, partitions=partitions, tags=tags)

    def get(self, name: str) -> LoadedTask:
        return self._source.get(name)
