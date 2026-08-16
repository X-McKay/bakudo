"""Shared repo-onboarding logic for ``bakudo repo add`` and ``POST /repos``
(repo onboarding, P2 Task 1).

Deliberately CLI-free and API-free: :func:`add_repo` raises typed errors
(:class:`RepoAddError` subclasses, or ``ValueError`` from
:meth:`Ledger.register_repo`) that each caller maps to its own error surface
(CLI exit code / HTTP status) rather than printing or raising HTTP errors
itself.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
from pathlib import Path

from .ledger import Ledger
from .records import RepoRecord

# A real remote URL (https://, git@...) or a file:// URL -- the latter
# included so `add_repo` can be exercised end-to-end (clone + all) without
# network access, using `git clone file://...` against a local repo.
_REPO_URL_RE = re.compile(r"^(https?://|git@|file://)")


class RepoAddError(Exception):
    """Base class for :func:`add_repo` failures.

    Callers map subclasses to their own error surface (CLI exit code / HTTP
    status); never raised bare.
    """


class RepoTargetExistsError(RepoAddError):
    """The intended clone target directory already exists."""


class RepoSourceInvalidError(RepoAddError):
    """The local path source does not exist, or is not a git checkout."""


class RepoCloneError(RepoAddError):
    """``git clone`` exited non-zero."""


def _infer_name(source: str) -> str:
    tail = source.rstrip("/").rsplit("/", 1)[-1]
    if tail.endswith(".git"):
        tail = tail[: -len(".git")]
    return tail


def _default_repo_root() -> Path:
    env_root = os.environ.get("BAKUDO_REPO_ROOT")
    return Path(env_root) if env_root else Path.cwd()


def add_repo(
    source: str,
    *,
    name: str | None = None,
    base_ref: str | None = None,
    ledger: Ledger,
    repo_root: Path | None = None,
) -> RepoRecord:
    """Clone (URL) or register in place (local path) a repo checkout, then
    ``ledger.register_repo`` it.

    A URL (matches ``_REPO_URL_RE``) is cloned via a plain ``git clone``
    subprocess into ``repo_root/<name>`` (``repo_root`` defaults to
    ``$BAKUDO_REPO_ROOT`` else the cwd) -- clone only, never execute repo
    content. A local path is verified to exist and contain ``.git`` and
    registered in place (no copy).

    If ``ledger.register_repo`` then rejects the record (a conflicting path
    for an already-registered name -- ``ValueError``), a clone THIS call
    just made is rolled back (``shutil.rmtree``, best-effort) before the
    error propagates, mirroring the cleanup-on-failure convention in
    ``AboxRunner.run``'s ``finally`` block (``abox/runner.py``): otherwise
    the orphaned clone directory would make every retry dead-end on
    :class:`RepoTargetExistsError` instead of surfacing the real conflict.
    A local path registered in place is never removed -- only a directory
    this invocation itself created is eligible for rollback.

    Raises :class:`RepoTargetExistsError`, :class:`RepoSourceInvalidError`,
    :class:`RepoCloneError`, or ``ValueError`` (from ``register_repo``).
    """
    cloned_target: Path | None = None
    if _REPO_URL_RE.match(source):
        repo_name = name or _infer_name(source)
        root = repo_root if repo_root is not None else _default_repo_root()
        target = root / repo_name
        if target.exists():
            raise RepoTargetExistsError(
                f"{target} already exists; refusing to clone over it"
            )
        try:
            subprocess.run(
                ["git", "clone", source, str(target)], check=True, capture_output=True
            )
        except subprocess.CalledProcessError as exc:
            stderr = (
                exc.stderr.decode(errors="replace")
                if isinstance(exc.stderr, bytes) else (exc.stderr or "")
            )
            raise RepoCloneError(f"git clone failed: {stderr.strip() or exc}") from exc
        cloned_target = target  # this invocation created it -- rollback-eligible
        path = target.resolve()
    else:
        candidate = Path(source)
        if not candidate.exists():
            raise RepoSourceInvalidError(f"{candidate} does not exist")
        if not (candidate / ".git").exists():
            raise RepoSourceInvalidError(f"{candidate} is not a git checkout (no .git)")
        repo_name = name or candidate.resolve().name
        path = candidate.resolve()

    record = RepoRecord(
        name=repo_name, source=source, path=str(path), default_base_ref=base_ref or "main",
    )
    try:
        ledger.register_repo(record)
    except ValueError:
        if cloned_target is not None:
            shutil.rmtree(cloned_target, ignore_errors=True)
        raise
    return record
