"""Storage-neutral workload discovery, immutable loading, and provenance."""

from __future__ import annotations

import os
import shutil
import tempfile
from collections.abc import Sequence
from pathlib import Path
from typing import Literal, Protocol
from urllib.parse import unquote, urlparse

import yaml
from pydantic import BaseModel, ConfigDict, Field, PrivateAttr

from ..schema import validate_workload_spec
from .models import SourceKind, WorkloadRef, WorkloadSpec
from .pins import WorkloadPin
from .verify import (
    WorkloadVerificationPolicy,
    iter_workload_files,
    verify_and_pin_workload,
)


class WorkloadLoadError(ValueError):
    """Raised when a workload source cannot return verified immutable input."""


class WorkloadCollectionManifest(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    api_version: Literal["bakudo.ai/v1alpha1"] = Field(
        default="bakudo.ai/v1alpha1", alias="apiVersion"
    )
    kind: Literal["WorkloadCollection"] = "WorkloadCollection"
    name: str
    revision: str
    source_uri: str | None = Field(default=None, alias="sourceURI")
    source_kind: SourceKind = Field(default=SourceKind.directory, alias="sourceKind")


class WorkloadProvenance(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    loaded_from_uri: str = Field(alias="loadedFromURI")
    source_uri: str = Field(alias="sourceURI")
    source_kind: SourceKind = Field(alias="sourceKind")
    collection_revision: str = Field(alias="collectionRevision")


class WorkloadSummary(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    name: str
    version: str
    description: str = ""
    labels: dict[str, str] = Field(default_factory=dict)
    manifest_digest: str = Field(alias="manifestDigest")

    @property
    def ref(self) -> str:
        return f"{self.name}@{self.version}"


class LoadedWorkload(BaseModel):
    """A validated snapshot whose bytes no longer depend on the source tree."""

    model_config = ConfigDict(arbitrary_types_allowed=True, extra="forbid", frozen=True)

    spec: WorkloadSpec
    root: Path
    provenance: WorkloadProvenance
    pin: WorkloadPin
    _materialization_owner: object | None = PrivateAttr(default=None)

    @property
    def ref(self) -> str:
        return self.spec.ref


class WorkloadSource(Protocol):
    @property
    def source_uri(self) -> str: ...

    @property
    def collection_revision(self) -> str: ...

    def list(self) -> tuple[WorkloadSummary, ...]: ...

    def load(self, ref: WorkloadRef | str) -> LoadedWorkload: ...


def durable_workload_source_location(workload: LoadedWorkload) -> str:
    """Return the locator a separate worker can use to fetch the pinned bytes.

    Packaged smoke workloads have a stable package URI while their physical
    installation directory is host-specific.  Other source kinds use the
    exact local directory or bundle from which this process loaded the bytes.
    """

    if workload.provenance.source_uri == "package://bakudo/smoke-workloads":
        return workload.provenance.source_uri
    return workload.provenance.loaded_from_uri


def load_workload_spec(workload_dir: Path) -> WorkloadSpec:
    manifest = workload_dir / "workload.yaml"
    try:
        data = yaml.safe_load(manifest.read_text())
        validate_workload_spec(data)
        return WorkloadSpec.model_validate(data)
    except OSError as exc:
        raise WorkloadLoadError(f"{manifest}: {exc}") from exc
    except yaml.YAMLError as exc:
        raise WorkloadLoadError(f"{manifest}: invalid YAML: {exc}") from exc
    except Exception as exc:
        raise WorkloadLoadError(f"{manifest}: {exc}") from exc


def _copy_snapshot(source: Path, destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=False)
    for path in iter_workload_files(source):
        relative = path.relative_to(source)
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, target)
    for directory in sorted(
        (item for item in destination.rglob("*") if item.is_dir()), reverse=True
    ):
        directory.chmod(0o555)
    for path in destination.rglob("*"):
        if path.is_file():
            path.chmod(0o444)
    destination.chmod(0o555)


class DirectoryWorkloadSource:
    """Discover immediate workload directories and snapshot them on load."""

    def __init__(
        self,
        root: Path,
        *,
        source_uri: str | None = None,
        collection_revision: str | None = None,
        source_kind: SourceKind | None = None,
        loaded_from_uri: str | None = None,
        policy: WorkloadVerificationPolicy | None = None,
    ) -> None:
        self.root = root.resolve()
        self.workload_root = self._resolve_workload_root()
        manifest = self._load_collection_manifest()
        self._source_uri = (
            source_uri or (manifest.source_uri if manifest else None) or self.root.as_uri()
        )
        self._source_kind = source_kind or (
            manifest.source_kind if manifest else SourceKind.directory
        )
        self._collection_revision = collection_revision or (
            manifest.revision if manifest else "unversioned"
        )
        self._loaded_from_uri = loaded_from_uri or self.root.as_uri()
        self._policy = policy or WorkloadVerificationPolicy()
        self._entries: dict[str, tuple[Path, WorkloadSpec, WorkloadPin]] = {}
        self._discover()

    @property
    def source_uri(self) -> str:
        return self._source_uri

    @property
    def collection_revision(self) -> str:
        return self._collection_revision

    def _resolve_workload_root(self) -> Path:
        for relative in (Path(".bakudo/workloads"), Path("workloads")):
            candidate = self.root / relative
            if candidate.is_dir():
                return candidate
        return self.root

    def _load_collection_manifest(self) -> WorkloadCollectionManifest | None:
        candidates = (self.root / "workloads.yaml", self.root / "collection.yaml")
        for path in candidates:
            if path.is_file():
                try:
                    document = yaml.safe_load(path.read_text())
                    return WorkloadCollectionManifest.model_validate(document)
                except Exception as exc:
                    raise WorkloadLoadError(f"{path}: {exc}") from exc
        return None

    def _candidate_directories(self) -> Sequence[Path]:
        if (self.workload_root / "workload.yaml").is_file():
            return (self.workload_root,)
        if not self.workload_root.is_dir():
            return ()
        return tuple(
            child
            for child in sorted(self.workload_root.iterdir())
            if child.is_dir() and (child / "workload.yaml").is_file()
        )

    def _pin(self, path: Path, spec: WorkloadSpec) -> WorkloadPin:
        report = verify_and_pin_workload(
            path,
            spec,
            source_uri=self.source_uri,
            source_kind=self._source_kind.value,
            collection_revision=self.collection_revision,
            policy=self._policy,
        )
        if not report.ok or report.pin is None:
            detail = "; ".join(f"{issue.path}: {issue.message}" for issue in report.issues)
            raise WorkloadLoadError(f"{path}: workload verification failed: {detail}")
        return report.pin

    def _discover(self) -> None:
        for child in self._candidate_directories():
            spec = load_workload_spec(child)
            pin = self._pin(child, spec)
            if spec.ref in self._entries:
                prior_pin = self._entries[spec.ref][2]
                if prior_pin.bundle_digest != pin.bundle_digest:
                    raise WorkloadLoadError(
                        f"workload version/digest collision for {spec.ref!r}: "
                        f"{prior_pin.bundle_digest} != {pin.bundle_digest}"
                    )
                raise WorkloadLoadError(f"duplicate workload ref {spec.ref!r} in {self.root}")
            self._entries[spec.ref] = (child, spec, pin)

    def list(self) -> tuple[WorkloadSummary, ...]:
        return tuple(
            WorkloadSummary(
                name=spec.metadata.name,
                version=spec.metadata.version,
                description=spec.metadata.description,
                labels=spec.metadata.labels,
                manifest_digest=pin.manifest_digest,
            )
            for _path, spec, pin in sorted(self._entries.values(), key=lambda item: item[1].ref)
        )

    def _resolve_ref(self, ref: WorkloadRef | str) -> tuple[Path, WorkloadSpec, WorkloadPin]:
        value = ref.ref if isinstance(ref, WorkloadRef) else ref
        if value in self._entries:
            return self._entries[value]
        matches = [entry for entry in self._entries.values() if entry[1].metadata.name == value]
        if len(matches) == 1:
            return matches[0]
        known = ", ".join(sorted(self._entries)) or "<none>"
        if len(matches) > 1:
            refs = ", ".join(sorted(entry[1].ref for entry in matches))
            raise KeyError(f"Ambiguous workload name {value!r} matches {refs}; use name@version.")
        raise KeyError(f"Unknown workload ref: {value!r}. Known refs: {known}") from None

    def load(self, ref: WorkloadRef | str) -> LoadedWorkload:
        source_path, spec, discovered_pin = self._resolve_ref(ref)
        live_spec = load_workload_spec(source_path)
        live_pin = self._pin(source_path, live_spec)
        if live_spec != spec or live_pin != discovered_pin:
            raise WorkloadLoadError(
                f"{spec.ref}: source changed after discovery; create a new source instance"
            )
        temporary = tempfile.TemporaryDirectory(prefix="bakudo-workload-")
        snapshot_root = Path(temporary.name) / "workload"
        try:
            _copy_snapshot(source_path, snapshot_root)
            snapshot_spec = load_workload_spec(snapshot_root)
            snapshot_pin = self._pin(snapshot_root, snapshot_spec)
            if snapshot_pin != discovered_pin:
                raise WorkloadLoadError(f"{spec.ref}: immutable snapshot digest mismatch")
        except Exception:
            temporary.cleanup()
            raise
        loaded = LoadedWorkload(
            spec=snapshot_spec,
            root=snapshot_root,
            provenance=WorkloadProvenance(
                loaded_from_uri=self._loaded_from_uri,
                source_uri=self.source_uri,
                source_kind=self._source_kind,
                collection_revision=self.collection_revision,
            ),
            pin=snapshot_pin,
        )
        loaded._materialization_owner = temporary
        return loaded


def _local_source_path(value: str) -> Path:
    parsed = urlparse(value)
    if parsed.scheme == "file":
        return Path(unquote(parsed.path))
    if parsed.scheme:
        raise ValueError(
            f"unsupported workload source URI scheme {parsed.scheme!r}; "
            "fetch remote artifacts into a local content-addressed cache first"
        )
    return Path(value)


def configured_workload_source() -> WorkloadSource | None:
    configured = os.environ.get("BAKUDO_WORKLOAD_SOURCE")
    if not configured:
        return None
    path = _local_source_path(configured).expanduser().resolve()
    if path.is_dir():
        return DirectoryWorkloadSource(path)
    from .bundle import BundleWorkloadSource

    return BundleWorkloadSource(path)


def workload_source_from_location(location: str) -> WorkloadSource:
    """Resolve one explicit local corpus/bundle location.

    Durable requests carry this location separately from the immutable
    :class:`WorkloadPin`: the location tells a worker where to fetch bytes,
    while the pin proves that the fetched bytes are exactly the requested
    version.
    """

    if location == "package://bakudo/smoke-workloads":
        from ..paths import smoke_workloads_dir

        return DirectoryWorkloadSource(
            smoke_workloads_dir(),
            source_uri=location,
            collection_revision="packaged-smoke-v1",
        )
    path = _local_source_path(location).expanduser().resolve()
    if path.is_dir():
        return DirectoryWorkloadSource(path)
    if path.is_file():
        from .bundle import BundleWorkloadSource

        return BundleWorkloadSource(path)
    raise FileNotFoundError(f"workload source does not exist: {path}")


def default_workload_source() -> WorkloadSource:
    """Resolve the configured corpus, falling back only to packaged smoke data."""

    configured = configured_workload_source()
    if configured is not None:
        return configured
    from ..paths import smoke_workloads_dir

    return DirectoryWorkloadSource(
        smoke_workloads_dir(),
        source_uri="package://bakudo/smoke-workloads",
        collection_revision="packaged-smoke-v1",
    )
