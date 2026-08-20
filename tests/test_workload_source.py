from __future__ import annotations

import copy
import hashlib
from pathlib import Path

import pytest
import yaml

from bakudo.performance.source import (
    DirectoryWorkloadSource,
    LoadedWorkload,
    WorkloadLoadError,
)


def _digest(data: bytes) -> str:
    return f"sha256:{hashlib.sha256(data).hexdigest()}"


def make_workload(
    root: Path,
    *,
    directory: str = "loop",
    name: str = "loop",
    version: str = "1.0.0",
) -> Path:
    workload = root / directory
    (workload / "data").mkdir(parents=True)
    script = b"import json\nprint(json.load(open('data/input.json'))['n'])\n"
    dataset = b'{"n": 100}\n'
    (workload / "run.py").write_bytes(script)
    (workload / "data" / "input.json").write_bytes(dataset)
    document = {
        "apiVersion": "bakudo.ai/v1alpha1",
        "kind": "WorkloadSpec",
        "metadata": {
            "name": name,
            "version": version,
            "description": "unit workload",
            "labels": {"language": "python"},
        },
        "subject": {"repo": "fixture-repo"},
        "command": {"argv": ["python", "run.py"], "cwd": ".", "env": {}},
        "dataset": {"path": "data/input.json", "digest": _digest(dataset)},
        "environment": {"profile": "python-small", "network": "none"},
        "measurement": {
            "warmups": 1,
            "repetitions": 3,
            "timeoutSeconds": 10,
            "schedule": "randomized-pairs",
            "metrics": [
                {
                    "name": "latency_seconds",
                    "unit": "seconds",
                    "direction": "lower",
                    "source": "wall-clock",
                    "estimator": "median",
                    "practicalThreshold": 0.05,
                }
            ],
        },
    }
    (workload / "workload.yaml").write_text(yaml.safe_dump(document, sort_keys=False))
    return workload


def test_directory_source_lists_and_loads_immutable_snapshot(tmp_path: Path) -> None:
    root = tmp_path / "workloads"
    root.mkdir()
    original = make_workload(root)
    source = DirectoryWorkloadSource(root, collection_revision="revision-1")

    assert [summary.ref for summary in source.list()] == ["loop@1.0.0"]
    loaded = source.load("loop")
    assert isinstance(loaded, LoadedWorkload)
    assert loaded.pin.collection_revision == "revision-1"
    assert [entry.path for entry in loaded.pin.dataset_digests] == ["data/input.json"]
    assert [entry.path for entry in loaded.pin.executor_digests] == ["run.py"]

    original_dataset = loaded.root.joinpath("data/input.json").read_bytes()
    (original / "data" / "input.json").write_text("changed")
    assert loaded.root.joinpath("data/input.json").read_bytes() == original_dataset


def test_snapshot_preserves_executable_bits_read_only(tmp_path: Path) -> None:
    """The immutable snapshot keeps executables executable (0o555, never
    writable): the abox staging layer restores +x in-guest from what it sees
    here, so a snapshot that flattens modes to 0o444 silently breaks any
    workload that executes a member directly."""
    root = tmp_path / "workloads"
    root.mkdir()
    workload = make_workload(root)
    tool = workload / "tool.sh"
    tool.write_text("#!/bin/sh\nexit 0\n")
    tool.chmod(0o755)

    loaded = DirectoryWorkloadSource(root).load("loop")

    assert (loaded.root / "tool.sh").stat().st_mode & 0o777 == 0o555
    assert (loaded.root / "run.py").stat().st_mode & 0o777 == 0o444


def test_source_detects_mutation_between_discovery_and_load(tmp_path: Path) -> None:
    root = tmp_path / "workloads"
    root.mkdir()
    workload = make_workload(root)
    source = DirectoryWorkloadSource(root)
    (workload / "run.py").write_text("print('mutated')\n")

    with pytest.raises(WorkloadLoadError, match="changed after discovery"):
        source.load("loop@1.0.0")


def test_source_rejects_dataset_digest_mismatch(tmp_path: Path) -> None:
    root = tmp_path / "workloads"
    root.mkdir()
    workload = make_workload(root)
    manifest = workload / "workload.yaml"
    document = yaml.safe_load(manifest.read_text())
    document["dataset"]["digest"] = "sha256:" + "0" * 64
    manifest.write_text(yaml.safe_dump(document, sort_keys=False))

    with pytest.raises(WorkloadLoadError, match="declared.*actual"):
        DirectoryWorkloadSource(root)


def test_source_rejects_symlinks(tmp_path: Path) -> None:
    root = tmp_path / "workloads"
    root.mkdir()
    workload = make_workload(root)
    (workload / "escape").symlink_to(tmp_path / "outside")

    with pytest.raises(WorkloadLoadError, match="symlink"):
        DirectoryWorkloadSource(root)


def test_bare_name_is_rejected_when_versions_are_ambiguous(tmp_path: Path) -> None:
    root = tmp_path / "workloads"
    root.mkdir()
    make_workload(root, directory="v1", name="loop", version="1.0.0")
    make_workload(root, directory="v2", name="loop", version="2.0.0")
    source = DirectoryWorkloadSource(root)

    with pytest.raises(KeyError, match="Ambiguous"):
        source.load("loop")
    assert source.load("loop@2.0.0").spec.metadata.version == "2.0.0"


def test_source_detects_version_digest_collision(tmp_path: Path) -> None:
    root = tmp_path / "workloads"
    root.mkdir()
    first = make_workload(root, directory="a")
    second = make_workload(root, directory="b")
    (second / "run.py").write_text("print('different')\n")
    # Both manifests still identify loop@1.0.0.
    assert (
        yaml.safe_load((first / "workload.yaml").read_text())["metadata"]
        == yaml.safe_load((second / "workload.yaml").read_text())["metadata"]
    )

    with pytest.raises(WorkloadLoadError, match="version/digest collision"):
        DirectoryWorkloadSource(root)


def test_source_listing_is_deterministic(tmp_path: Path) -> None:
    root = tmp_path / "workloads"
    root.mkdir()
    make_workload(root, directory="z", name="z-workload")
    make_workload(root, directory="a", name="a-workload")
    source = DirectoryWorkloadSource(root)
    assert [item.ref for item in source.list()] == ["a-workload@1.0.0", "z-workload@1.0.0"]


def test_unknown_manifest_field_fails_at_source_boundary(tmp_path: Path) -> None:
    root = tmp_path / "workloads"
    root.mkdir()
    workload = make_workload(root)
    manifest = workload / "workload.yaml"
    document = copy.deepcopy(yaml.safe_load(manifest.read_text()))
    document["unexpected"] = True
    manifest.write_text(yaml.safe_dump(document, sort_keys=False))
    with pytest.raises(WorkloadLoadError, match="Additional properties"):
        DirectoryWorkloadSource(root)
