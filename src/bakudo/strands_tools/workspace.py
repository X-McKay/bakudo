"""A confined view of the sandbox workspace shared by file/command tools."""

from __future__ import annotations

import subprocess
from dataclasses import dataclass
from pathlib import Path


class PathEscape(Exception):
    """Raised when a tool path resolves outside the workspace root."""


@dataclass
class Workspace:
    """The git worktree mounted into the sandbox at ``/workspace``.

    All file operations are confined to ``root``; attempts to escape via
    ``..`` or absolute paths are rejected. This is defence-in-depth on top of
    abox's filesystem isolation.
    """

    root: Path

    def __post_init__(self) -> None:
        self.root = Path(self.root).resolve()

    def resolve(self, relative: str) -> Path:
        candidate = (self.root / relative).resolve()
        if candidate != self.root and self.root not in candidate.parents:
            raise PathEscape(f"Path '{relative}' escapes the workspace root.")
        return candidate

    def read(self, relative: str) -> str:
        return self.resolve(relative).read_text()

    def write(self, relative: str, content: str) -> int:
        path = self.resolve(relative)
        # Defence-in-depth (SEC-2): refuse to write *through* a final symlink.
        # resolve() confirms the fully-resolved target is under root, but a
        # symlink at the write target is the classic confinement-bypass vector
        # (swap it to repoint a subsequent write); the local dev sandbox — the
        # only filesystem guard when not running under abox — writes real files
        # only. mkdir(exist_ok) never *creates* a symlink, so guarding the leaf
        # is sufficient.
        raw = self.root / relative
        if raw.is_symlink():
            raise PathEscape(f"Path '{relative}' is a symlink; refusing to write through it.")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
        return len(content)

    def run(self, argv: list[str], timeout: int = 600) -> subprocess.CompletedProcess:
        """Run a command inside the workspace, capturing output."""
        return subprocess.run(
            argv,
            cwd=self.root,
            capture_output=True,
            text=True,
            timeout=timeout,
        )

    def _untracked_files(self) -> list[str]:
        proc = self.run(["git", "ls-files", "--others", "--exclude-standard"])
        return [line.strip() for line in proc.stdout.splitlines() if line.strip()]

    def git_diff(self) -> str:
        """The working-tree diff, *including* untracked files (ABOX-9).

        Plain ``git diff`` is blind to newly created files, which silently
        defeats ``maxChangedFiles`` gates and diff-based evals on create-only
        changes. Untracked content is appended via ``git diff --no-index``
        against ``/dev/null`` (which exits 1 on a difference — expected).
        """
        parts = [self.run(["git", "diff", "--no-color"]).stdout]
        for name in self._untracked_files():
            proc = self.run(["git", "diff", "--no-color", "--no-index", "--", "/dev/null", name])
            parts.append(proc.stdout)
        return "".join(parts)

    def changed_files(self) -> list[str]:
        """Tracked modifications plus untracked files (ABOX-9)."""
        proc = self.run(["git", "diff", "--name-only"])
        tracked = [line for line in proc.stdout.splitlines() if line.strip()]
        return sorted(set(tracked) | set(self._untracked_files()))
