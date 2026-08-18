from __future__ import annotations

import gc
import io
import tarfile
from pathlib import Path

import pytest

from bakudo.performance.bundle import (
    BundleWorkloadSource,
    WorkloadBundleError,
    publish_workload_bundle,
)
from bakudo.performance.source import DirectoryWorkloadSource
from test_workload_source import make_workload


def _source(tmp_path: Path) -> DirectoryWorkloadSource:
    root = tmp_path / "workloads"
    root.mkdir(parents=True)
    make_workload(root)
    return DirectoryWorkloadSource(
        root,
        source_uri="https://example.test/workloads",
        collection_revision="revision-123",
    )


def test_bundle_is_byte_deterministic_and_loads_identical_pin(tmp_path: Path) -> None:
    loaded = _source(tmp_path / "source").load("loop")
    first = publish_workload_bundle(loaded, tmp_path / "first")
    second = publish_workload_bundle(loaded, tmp_path / "second")
    assert first.name == second.name
    assert first.read_bytes() == second.read_bytes()

    archive_source = BundleWorkloadSource(first)
    from_archive = archive_source.load("loop@1.0.0")
    assert from_archive.pin == loaded.pin
    assert from_archive.provenance.loaded_from_uri == first.resolve().as_uri()
    gc.collect()
    assert (from_archive.root / "workload.yaml").is_file()


def test_bundle_rejects_content_tampering(tmp_path: Path) -> None:
    loaded = _source(tmp_path / "source").load("loop")
    artifact = publish_workload_bundle(loaded, tmp_path / "artifacts")
    data = artifact.read_bytes()
    assert b"unit workload" in data
    artifact.write_bytes(data.replace(b"unit workload", b"evil workload", 1))
    with pytest.raises(WorkloadBundleError, match="digest"):
        BundleWorkloadSource(artifact)


def _write_tar(path: Path, members: list[tuple[tarfile.TarInfo, bytes]]) -> None:
    with tarfile.open(path, "w") as archive:
        for info, data in members:
            archive.addfile(info, io.BytesIO(data))


def test_bundle_rejects_entry_traversal(tmp_path: Path) -> None:
    artifact = tmp_path / "traversal.tar"
    info = tarfile.TarInfo("workload/../../escape")
    info.size = 1
    _write_tar(artifact, [(info, b"x")])
    with pytest.raises(WorkloadBundleError, match="unsafe"):
        BundleWorkloadSource(artifact)


def test_bundle_rejects_symlinks(tmp_path: Path) -> None:
    artifact = tmp_path / "symlink.tar"
    info = tarfile.TarInfo("workload/run.py")
    info.type = tarfile.SYMTYPE
    info.linkname = "../../escape"
    _write_tar(artifact, [(info, b"")])
    with pytest.raises(WorkloadBundleError, match="regular file"):
        BundleWorkloadSource(artifact)


def test_bundle_rejects_duplicate_entries(tmp_path: Path) -> None:
    artifact = tmp_path / "duplicate.tar"
    first = tarfile.TarInfo("workload/a")
    first.size = 1
    second = tarfile.TarInfo("workload/a")
    second.size = 1
    _write_tar(artifact, [(first, b"a"), (second, b"b")])
    with pytest.raises(WorkloadBundleError, match="duplicate"):
        BundleWorkloadSource(artifact)
