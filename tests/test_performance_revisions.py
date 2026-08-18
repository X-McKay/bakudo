from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from bakudo.performance.revisions import RevisionResolutionError, pin_repository_revision


def _git(repo: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True)


def _repo(tmp_path: Path) -> Path:
    repo = tmp_path / "demo"
    repo.mkdir()
    _git(repo, "init", "-q")
    _git(repo, "config", "user.email", "test@example.com")
    _git(repo, "config", "user.name", "Test")
    (repo / "app.py").write_text("value = 1\n")
    _git(repo, "add", "app.py")
    _git(repo, "commit", "-q", "-m", "initial")
    return repo


def test_pin_repository_revision_is_stable_and_patch_is_distinct(tmp_path: Path) -> None:
    repo = _repo(tmp_path)

    baseline = pin_repository_revision(repo)
    candidate = pin_repository_revision(
        repo,
        patch="diff --git a/app.py b/app.py\n--- a/app.py\n+++ b/app.py\n",
    )

    assert baseline.commit_sha == candidate.commit_sha
    assert baseline.tree_digest == candidate.tree_digest
    assert baseline.patch_digest is None
    assert candidate.base_commit_sha == baseline.commit_sha
    assert candidate.patch_digest is not None


def test_dirty_baseline_fails_closed_but_can_be_inspected_explicitly(tmp_path: Path) -> None:
    repo = _repo(tmp_path)
    (repo / "app.py").write_text("value = 2\n")

    with pytest.raises(RevisionResolutionError, match="uncommitted changes"):
        pin_repository_revision(repo)

    assert pin_repository_revision(repo, require_clean=False).dirty is True


def test_non_repository_is_rejected(tmp_path: Path) -> None:
    with pytest.raises(RevisionResolutionError, match="not a git checkout"):
        pin_repository_revision(tmp_path)


def test_pin_can_use_registered_repository_identity(tmp_path: Path) -> None:
    pin = pin_repository_revision(_repo(tmp_path), repository="registered-name")

    assert pin.repository == "registered-name"
