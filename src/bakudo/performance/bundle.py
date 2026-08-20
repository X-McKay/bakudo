"""Deterministic publication and fail-closed loading of workload bundles."""

from __future__ import annotations

import io
import json
import tarfile
import tempfile
from pathlib import Path, PurePosixPath
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from .models import SourceKind, WorkloadRef
from .source import DirectoryWorkloadSource, LoadedWorkload, WorkloadSummary
from .verify import (
    MAX_WORKLOAD_FILE_BYTES,
    MAX_WORKLOAD_FILES,
    MAX_WORKLOAD_TOTAL_BYTES,
    iter_workload_files,
)


class WorkloadBundleError(ValueError):
    """Raised when a bundle is unsafe, ambiguous, or fails its pin."""


class WorkloadBundleManifest(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    api_version: Literal["bakudo.ai/v1alpha1"] = Field(
        default="bakudo.ai/v1alpha1", alias="apiVersion"
    )
    kind: Literal["WorkloadBundle"] = "WorkloadBundle"
    source_uri: str = Field(alias="sourceURI")
    source_kind: SourceKind = Field(alias="sourceKind")
    collection_revision: str = Field(alias="collectionRevision")
    workload_name: str = Field(alias="workloadName")
    workload_version: str = Field(alias="workloadVersion")
    manifest_digest: str = Field(alias="manifestDigest")
    bundle_digest: str = Field(alias="bundleDigest")


def _tar_info(name: str, size: int, *, executable: bool = False) -> tarfile.TarInfo:
    info = tarfile.TarInfo(name)
    info.size = size
    # Only two mode values keep bundles byte-deterministic while carrying
    # the one behavior-relevant permission (the runners restore +x in-guest).
    info.mode = 0o755 if executable else 0o644
    info.mtime = 0
    info.uid = 0
    info.gid = 0
    info.uname = ""
    info.gname = ""
    return info


def publish_workload_bundle(workload: LoadedWorkload, output_dir: Path) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    artifact = output_dir / f"{workload.pin.bundle_digest.removeprefix('sha256:')}.tar"
    manifest = WorkloadBundleManifest(
        source_uri=workload.pin.source_uri,
        source_kind=workload.pin.source_kind,
        collection_revision=workload.pin.collection_revision,
        workload_name=workload.pin.name,
        workload_version=workload.pin.version,
        manifest_digest=workload.pin.manifest_digest,
        bundle_digest=workload.pin.bundle_digest,
    )
    manifest_bytes = (
        json.dumps(manifest.model_dump(by_alias=True, mode="json"), indent=2, sort_keys=True) + "\n"
    ).encode("utf-8")
    with tarfile.open(artifact, "w", format=tarfile.USTAR_FORMAT) as archive:
        archive.addfile(_tar_info("bundle.json", len(manifest_bytes)), io.BytesIO(manifest_bytes))
        for path in iter_workload_files(workload.root):
            relative = path.relative_to(workload.root).as_posix()
            data = path.read_bytes()
            archive.addfile(
                _tar_info(
                    f"workload/{relative}",
                    len(data),
                    executable=bool(path.stat().st_mode & 0o111),
                ),
                io.BytesIO(data),
            )
    return artifact


def _safe_archive_name(name: str) -> PurePosixPath:
    if "\\" in name:
        raise WorkloadBundleError(f"unsafe workload bundle member: {name!r}")
    path = PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts or "." in path.parts:
        raise WorkloadBundleError(f"unsafe workload bundle member: {name!r}")
    return path


def extract_workload_bundle(
    artifact: Path, destination: Path
) -> tuple[WorkloadBundleManifest, Path]:
    destination.mkdir(parents=True, exist_ok=True)
    workload_root = destination / "workload"
    manifest: WorkloadBundleManifest | None = None
    seen: set[PurePosixPath] = set()
    count = 0
    total = 0
    try:
        archive = tarfile.open(artifact, "r:")
    except (OSError, tarfile.TarError) as exc:
        raise WorkloadBundleError(f"{artifact}: invalid workload bundle: {exc}") from exc
    with archive:
        for member in archive.getmembers():
            relative = _safe_archive_name(member.name)
            if relative in seen:
                raise WorkloadBundleError(f"duplicate workload bundle member: {member.name!r}")
            seen.add(relative)
            if member.isdir():
                continue
            if not member.isfile():
                raise WorkloadBundleError(
                    f"workload bundle member must be a regular file: {member.name!r}"
                )
            if member.size > MAX_WORKLOAD_FILE_BYTES:
                raise WorkloadBundleError(f"oversized workload bundle member: {member.name!r}")
            count += 1
            total += member.size
            if count > MAX_WORKLOAD_FILES + 1 or total > MAX_WORKLOAD_TOTAL_BYTES:
                raise WorkloadBundleError("workload bundle exceeds resource limits")
            stream = archive.extractfile(member)
            if stream is None:
                raise WorkloadBundleError(f"could not read workload bundle member {member.name!r}")
            data = stream.read(MAX_WORKLOAD_FILE_BYTES + 1)
            if len(data) != member.size:
                raise WorkloadBundleError(f"workload bundle member size mismatch: {member.name!r}")
            if relative == PurePosixPath("bundle.json"):
                if manifest is not None:
                    raise WorkloadBundleError("workload bundle contains multiple manifests")
                try:
                    manifest = WorkloadBundleManifest.model_validate_json(data)
                except Exception as exc:
                    raise WorkloadBundleError(f"invalid bundle.json: {exc}") from exc
                continue
            if not relative.parts or relative.parts[0] != "workload" or len(relative.parts) < 2:
                raise WorkloadBundleError(f"unexpected workload bundle member: {member.name!r}")
            target = destination.joinpath(*relative.parts)
            try:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
                # Restore the one behavior-relevant permission before the
                # exec-aware content digest is recomputed and verified.
                if member.mode & 0o111:
                    target.chmod(0o755)
            except OSError as exc:
                raise WorkloadBundleError(
                    f"could not materialize workload bundle member {member.name!r}: {exc}"
                ) from exc
    if manifest is None:
        raise WorkloadBundleError(f"{artifact}: missing bundle.json")
    return manifest, workload_root


class BundleWorkloadSource:
    """A source backed by one locally cached, content-addressed tar bundle."""

    def __init__(self, artifact: Path) -> None:
        self.artifact = artifact.resolve()
        self._temporary = tempfile.TemporaryDirectory(prefix="bakudo-workload-bundle-")
        root = Path(self._temporary.name)
        try:
            manifest, _workload_root = extract_workload_bundle(self.artifact, root)
            self._source = DirectoryWorkloadSource(
                root,
                source_uri=manifest.source_uri,
                source_kind=manifest.source_kind,
                collection_revision=manifest.collection_revision,
                loaded_from_uri=self.artifact.as_uri(),
            )
            summaries = self._source.list()
            if len(summaries) != 1:
                raise WorkloadBundleError(
                    f"{artifact}: expected exactly one workload, found {len(summaries)}"
                )
            loaded = self._source.load(summaries[0].ref)
            if (
                loaded.pin.name != manifest.workload_name
                or loaded.pin.version != manifest.workload_version
            ):
                raise WorkloadBundleError("workload identity does not match bundle manifest")
            if loaded.pin.manifest_digest != manifest.manifest_digest:
                raise WorkloadBundleError("workload manifest digest does not match bundle manifest")
            if loaded.pin.bundle_digest != manifest.bundle_digest:
                raise WorkloadBundleError("workload bundle digest mismatch")
        except WorkloadBundleError:
            self._temporary.cleanup()
            raise
        except Exception as exc:
            self._temporary.cleanup()
            raise WorkloadBundleError(f"{artifact}: {exc}") from exc

    @property
    def source_uri(self) -> str:
        return self._source.source_uri

    @property
    def collection_revision(self) -> str:
        return self._source.collection_revision

    def list(self) -> tuple[WorkloadSummary, ...]:
        return self._source.list()

    def load(self, ref: WorkloadRef | str) -> LoadedWorkload:
        loaded = self._source.load(ref)
        loaded._materialization_owner = (self._temporary, loaded._materialization_owner)
        return loaded
