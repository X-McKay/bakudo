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

    def git_diff(self) -> str:
        proc = self.run(["git", "diff", "--no-color"])
        return proc.stdout

    def changed_files(self) -> list[str]:
        proc = self.run(["git", "diff", "--name-only"])
        return [line for line in proc.stdout.splitlines() if line.strip()]
