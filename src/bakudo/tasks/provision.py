"""Deterministic fixture provisioner.

Turns a validated task's ``fixture/`` directory into a fresh git
repository with a single, fully-deterministic commit: the same task
directory provisioned twice (regardless of destination path or host
machine) produces byte-identical tree content and therefore the identical
commit sha. That sha (``base_ref``) is the reproducible starting point the
eval runner hands to an agent.

Only file copies and ``git`` subprocess calls are ever used here — nothing
from the fixture is executed. Only ``fixture/`` is copied; a task's
``verifier/`` and ``reference/`` directories are never part of the
provisioned workspace, so verifier tests and reference solutions can never
leak to the agent under test.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

from .source import LoadedTask

# Fixed identity + timestamp for every provisioned commit. Using constants
# instead of "now"/the host user is what makes `base_ref` reproducible
# across machines and across time.
_GIT_ENV = {
    "GIT_AUTHOR_NAME": "bakudo-provisioner",
    "GIT_AUTHOR_EMAIL": "provision@bakudo.invalid",
    "GIT_AUTHOR_DATE": "2026-01-01T00:00:00 +0000",
    "GIT_COMMITTER_NAME": "bakudo-provisioner",
    "GIT_COMMITTER_EMAIL": "provision@bakudo.invalid",
    "GIT_COMMITTER_DATE": "2026-01-01T00:00:00 +0000",
    # Prevent host/user git config (core.autocrlf, commit.gpgsign, an
    # ambient user.name, ...) from ever influencing the commit.
    "GIT_CONFIG_GLOBAL": "/dev/null",
    "GIT_CONFIG_SYSTEM": "/dev/null",
}


@dataclass(frozen=True)
class ProvisionedWorkspace:
    """A task's fixture, materialized as a fresh single-commit git repo."""

    repo_path: Path
    base_ref: str
    seed: int


def _copy_fixture(fixture_dir: Path, repo_path: Path) -> None:
    """Copy ``fixture_dir`` into ``repo_path`` via a sorted walk.

    Pure file/directory copies only -- nothing from the fixture is ever
    executed or imported.
    """
    repo_path.mkdir(parents=True, exist_ok=True)
    for src in sorted(fixture_dir.rglob("*")):
        rel = src.relative_to(fixture_dir)
        dest = repo_path / rel
        if src.is_dir():
            dest.mkdir(parents=True, exist_ok=True)
        else:
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dest)


def _run_git(args: list[str], cwd: Path, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args],
        cwd=cwd,
        env=env,
        check=True,
        capture_output=True,
        text=True,
    )


def provision(task: LoadedTask, dest: Path, seed: int) -> ProvisionedWorkspace:
    """Materialize ``task``'s fixture under ``dest/repo`` as a fresh git
    repo with a single deterministic commit, and return the workspace.

    ``base_ref`` (the resulting HEAD sha) is identical across repeated
    calls for the same task content: same bytes in, same tree, same
    fixed author/committer identity and date, so the commit hashes match.
    """
    fixture_dir = task.path / "fixture"
    repo_path = dest / "repo"
    _copy_fixture(fixture_dir, repo_path)

    env = {**os.environ, **_GIT_ENV}

    _run_git(["init", "-q"], repo_path, env)
    _run_git(["add", "-A"], repo_path, env)
    _run_git(
        ["commit", "-q", "-m", "provision: initial fixture state", "--allow-empty"],
        repo_path,
        env,
    )
    result = _run_git(["rev-parse", "HEAD"], repo_path, env)
    base_ref = result.stdout.strip()

    return ProvisionedWorkspace(repo_path=repo_path, base_ref=base_ref, seed=seed)
