"""Immutable workload, repository-revision, and environment identities."""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

Digest = Annotated[str, StringConstraints(pattern=r"^sha256:[0-9a-f]{64}$")]
SemanticVersion = Annotated[
    str,
    StringConstraints(pattern=r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$")
]
RelativePath = Annotated[
    str,
    StringConstraints(pattern=r"^[A-Za-z0-9_][A-Za-z0-9_.-]*(/[A-Za-z0-9_][A-Za-z0-9_.-]*)*$"),
]
NonNegativeInt = Annotated[int, Field(ge=0)]
NonEmpty = Annotated[str, StringConstraints(min_length=1, max_length=2_048)]


class _Pin(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)


class FileDigest(_Pin):
    path: RelativePath
    digest: Digest


class RuntimeVersion(_Pin):
    name: Annotated[str, StringConstraints(min_length=1, max_length=128)]
    version: Annotated[str, StringConstraints(min_length=1, max_length=128)]


class WorkloadPin(_Pin):
    source_uri: NonEmpty = Field(alias="sourceURI")
    source_kind: Literal["directory", "repository", "bundle"] = Field(alias="sourceKind")
    collection_revision: Annotated[str, StringConstraints(min_length=1, max_length=256)] = Field(
        alias="collectionRevision"
    )
    name: Annotated[str, StringConstraints(pattern=r"^[a-z][a-z0-9-]{0,62}$")]
    version: SemanticVersion
    manifest_digest: Digest = Field(alias="manifestDigest")
    dataset_digests: tuple[FileDigest, ...] = Field(default_factory=tuple, alias="datasetDigests")
    executor_digests: tuple[FileDigest, ...] = Field(
        default_factory=tuple, alias="executorDigests"
    )
    bundle_digest: Digest = Field(alias="bundleDigest")

    @property
    def ref(self) -> str:
        return f"{self.name}@{self.version}"

    @model_validator(mode="after")
    def unique_members(self) -> WorkloadPin:
        for label, members in (
            ("datasetDigests", self.dataset_digests),
            ("executorDigests", self.executor_digests),
        ):
            paths = [member.path for member in members]
            if len(paths) != len(set(paths)):
                raise ValueError(f"{label} must contain unique paths")
        return self


class RevisionPin(_Pin):
    repository: Annotated[str, StringConstraints(min_length=1, max_length=256)]
    source_uri: NonEmpty = Field(alias="sourceURI")
    commit_sha: Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{40,64}$")] = Field(
        alias="commitSHA"
    )
    tree_digest: Digest = Field(alias="treeDigest")
    dirty: bool = False
    base_commit_sha: Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{40,64}$")] | None = (
        Field(default=None, alias="baseCommitSHA")
    )
    patch_digest: Digest | None = Field(default=None, alias="patchDigest")

    @model_validator(mode="after")
    def candidate_fields_are_paired(self) -> RevisionPin:
        if (self.base_commit_sha is None) != (self.patch_digest is None):
            raise ValueError("baseCommitSHA and patchDigest must be supplied together")
        return self


class EnvironmentPin(_Pin):
    bakudo_version: Annotated[str, StringConstraints(min_length=1, max_length=128)] = Field(
        alias="bakudoVersion"
    )
    abox_version: Annotated[str, StringConstraints(min_length=1, max_length=128)] = Field(
        alias="aboxVersion"
    )
    image_digest: Digest = Field(alias="imageDigest")
    profile: Annotated[str, StringConstraints(min_length=1, max_length=128)]
    hardware_class: Annotated[str, StringConstraints(min_length=1, max_length=128)] = Field(
        alias="hardwareClass"
    )
    architecture: Annotated[str, StringConstraints(min_length=1, max_length=128)]
    cpu_count: int = Field(alias="cpuCount", ge=1)
    cpu_affinity: tuple[NonNegativeInt, ...] = Field(default_factory=tuple, alias="cpuAffinity")
    memory_mb: int = Field(alias="memoryMb", ge=1)
    os: Annotated[str, StringConstraints(min_length=1, max_length=128)]
    kernel: Annotated[str, StringConstraints(min_length=1, max_length=128)]
    runtime_versions: tuple[RuntimeVersion, ...] = Field(
        default_factory=tuple, alias="runtimeVersions"
    )
    dependency_lock_digest: Digest = Field(alias="dependencyLockDigest")
    environment_digest: Digest = Field(alias="environmentDigest")
    profiler_adapter: str | None = Field(default=None, alias="profilerAdapter")
    profiler_version: str | None = Field(default=None, alias="profilerVersion")

    @model_validator(mode="after")
    def profiler_fields_are_paired(self) -> EnvironmentPin:
        if (self.profiler_adapter is None) != (self.profiler_version is None):
            raise ValueError("profilerAdapter and profilerVersion must be supplied together")
        names = [runtime.name for runtime in self.runtime_versions]
        if len(names) != len(set(names)):
            raise ValueError("runtimeVersions must contain unique names")
        if len(self.cpu_affinity) != len(set(self.cpu_affinity)):
            raise ValueError("cpuAffinity must not contain duplicates")
        if any(cpu < 0 for cpu in self.cpu_affinity):
            raise ValueError("cpuAffinity entries must be non-negative")
        return self
