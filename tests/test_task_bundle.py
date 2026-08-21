from __future__ import annotations

import gc
from pathlib import Path

import pytest

from bakudo.tasks.bundle import ArchiveTaskSource, publish_bundle
from bakudo.tasks.source import DirectoryTaskSource, TaskLoadError


def _task_source(root: Path) -> DirectoryTaskSource:
    root.mkdir(parents=True)
    (root / "corpus.yaml").write_text(
        "apiVersion: bakudo.ai/v1alpha1\nkind: TaskCorpus\nname: unit\nrevision: rev-123\n"
    )
    task = root / "unit-task"
    (task / "fixture").mkdir(parents=True)
    (task / "verifier").mkdir()
    (task / "fixture" / "app.py").write_text("def value():\n    return 1\n")
    (task / "verifier" / "test_value.py").write_text(
        "from app import value\n\ndef test_value():\n    assert value() == 2\n"
    )
    (task / "task.yaml").write_text(
        """apiVersion: bakudo.ai/v1alpha1
kind: TaskSpec
metadata:
  name: unit-task
  version: 1
  family: debugging
  difficulty: easy
  tags: [python]
  partition: dev
  canary: unit-canary
  provenance:
    createdBy: test
    createdAt: "2026-08-16"
    sourceType: hand-written
    eligibleForPromotion: false
instruction:
  type: qa
  title: Fix value
  description: Return the correct value.
  successCriteria: [Verifier passes]
environment:
  profile: python-glibc
  network: none
limits:
  wallSeconds: 60
verifier:
  failToPass: [verifier/test_value.py]
  passToPass: []
  command: pytest {files} -q
  negativeControls: []
constraints:
  expectedStatus: success
  allowedChangePaths: [app.py]
  maxChangedFiles: 1
  forbidsDeniedActions: true
  verifierInputsImmutable: true
"""
    )
    return DirectoryTaskSource(root)


def test_published_bundle_is_deterministic_and_loadable(tmp_path: Path) -> None:
    task = _task_source(tmp_path / "corpus").get("unit-task")
    first = publish_bundle(task, tmp_path / "first")

    cache = task.path / "fixture" / "__pycache__"
    cache.mkdir()
    (cache / "app.cpython-312.pyc").write_bytes(b"derived bytecode")
    second = publish_bundle(task, tmp_path / "second")

    assert first.name == second.name
    assert first.read_bytes() == second.read_bytes()

    loaded = ArchiveTaskSource(first).get("unit-task")
    assert loaded.pin.source_uri == first.resolve().as_uri()
    assert loaded.pin.corpus_revision == "rev-123"
    assert loaded.pin.bundle_digest == task.pin.bundle_digest
    assert loaded.pin.verifier_digest == task.pin.verifier_digest
    gc.collect()
    assert loaded.path.is_dir()
    assert (loaded.path / "task.yaml").is_file()
    assert not (loaded.path / "fixture" / "__pycache__").exists()


def test_bundle_loader_rejects_content_tampering(tmp_path: Path) -> None:
    task = _task_source(tmp_path / "corpus").get("unit-task")
    artifact = publish_bundle(task, tmp_path / "artifacts")
    data = artifact.read_bytes()
    assert b"return 1" in data
    artifact.write_bytes(data.replace(b"return 1", b"return 2", 1))

    with pytest.raises(TaskLoadError, match="bundle digest mismatch"):
        ArchiveTaskSource(artifact)
