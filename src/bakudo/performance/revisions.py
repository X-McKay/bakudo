"""Resolve immutable repository revision identities without executing repo code."""

from __future__ import annotations

import hashlib
import subprocess
from pathlib import Path

from .pins import RevisionPin


class RevisionResolutionError(ValueError):
    """Raised when a repository revision cannot be pinned safely."""


def _git(repo: Path, *args: str) -> str:
    try:
        result = subprocess.run(
            ["git", "-C", str(repo), *args],
            capture_output=True,
            check=False,
            text=True,
            timeout=120,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise RevisionResolutionError(f"git {' '.join(args)} failed: {exc}") from exc
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()[-1_000:]
        raise RevisionResolutionError(f"git {args[0]} failed: {detail}")
    return result.stdout


def sha256_text(value: str) -> str:
    return f"sha256:{hashlib.sha256(value.encode('utf-8')).hexdigest()}"


def pin_repository_revision(
    repo: Path,
    ref: str = "HEAD",
    *,
    repository: str | None = None,
    patch: str | None = None,
    require_clean: bool = True,
) -> RevisionPin:
    """Pin a git revision and optional candidate patch.

    The tree digest hashes git's canonical recursive tree listing rather than
    walking the mutable checkout. A persistent baseline is rejected when the
    checkout is dirty. Candidate identity pairs the resolved base commit with
    the exact patch digest; applying the patch remains a sandbox-runner concern.
    """

    repo = repo.expanduser().resolve()
    if not (repo / ".git").exists():
        raise RevisionResolutionError(f"not a git checkout: {repo}")

    dirty = bool(_git(repo, "status", "--porcelain", "--untracked-files=normal").strip())
    if dirty and require_clean:
        raise RevisionResolutionError(
            f"repository has uncommitted changes and cannot be a persistent baseline: {repo}"
        )

    commit_sha = _git(repo, "rev-parse", "--verify", f"{ref}^{{commit}}").strip()
    tree_listing = _git(repo, "ls-tree", "-r", "--full-tree", commit_sha)
    patch_digest = sha256_text(patch) if patch is not None else None
    return RevisionPin(
        repository=repository or repo.name,
        source_uri=repo.as_uri(),
        commit_sha=commit_sha,
        tree_digest=sha256_text(tree_listing),
        dirty=dirty,
        base_commit_sha=commit_sha if patch is not None else None,
        patch_digest=patch_digest,
    )
