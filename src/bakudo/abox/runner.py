"""Materialise a task bundle and drive an ``abox`` sandbox run (spec section 6).

This is invoked from a Temporal *activity* (non-deterministic external work),
never from workflow code. It:

1. writes the task bundle parts into a per-run ``/abox-meta`` mount,
2. constructs the ``abox run ... -- agent-runner ...`` command line,
3. executes it (or a supplied fake executor for tests/dry-runs),
4. collects ``result.json``, the diff, logs, and exit code.

The canonical run id is reused as the abox task id (spec section 6.3).
"""

from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

from .. import ids
from ..bundle import TaskBundle

# An executor runs the argv and returns (exit_code, stdout, stderr). Swappable
# so tests and dry-runs need not have the abox binary installed.
Executor = Callable[[list[str]], "ExecResult"]


@dataclass
class ExecResult:
    exit_code: int
    stdout: str = ""
    stderr: str = ""


@dataclass(frozen=True)
class SandboxProfile:
    """An abox sandbox policy profile (spec section 6.4)."""

    name: str
    network_mode: str = "scoped"
    network_bundles: tuple[str, ...] = ()
    allowed_commands: tuple[str, ...] = ()
    max_changed_files: int | None = None
    max_diff_bytes: int | None = None
    can_merge: bool = False
    ephemeral: bool = True
    max_runtime_seconds: int = 3600


# The starter profiles named in the spec (section 6.4).
PROFILES: dict[str, SandboxProfile] = {
    "explore-readonly": SandboxProfile(
        name="explore-readonly", network_mode="none", can_merge=False, ephemeral=True
    ),
    "add-feature-python": SandboxProfile(
        name="add-feature-python",
        network_bundles=("github-api", "pypi-public", "vllm-gateway"),
        max_changed_files=20,
        can_merge=False,
        ephemeral=False,
    ),
    "qa-candidate-branch": SandboxProfile(
        name="qa-candidate-branch",
        network_bundles=("vllm-gateway",),
        can_merge=False,
        ephemeral=False,
    ),
    "skill-author": SandboxProfile(
        name="skill-author",
        network_bundles=("vllm-gateway",),
        can_merge=False,
        ephemeral=False,
    ),
    "restricted-network": SandboxProfile(
        name="restricted-network", network_mode="none", ephemeral=True
    ),
}


@dataclass
class AboxOutcome:
    """Everything collected from a finished sandbox run."""

    run_id: str
    abox_task_id: str
    exit_code: int
    git_branch: str
    result: dict | None = None
    diff: str = ""
    changed_files: list[str] = field(default_factory=list)
    stdout: str = ""
    stderr: str = ""

    @property
    def succeeded(self) -> bool:
        return self.exit_code == 0 and self.result is not None


def _subprocess_executor(argv: list[str]) -> ExecResult:  # pragma: no cover - needs abox
    proc = subprocess.run(argv, capture_output=True, text=True)
    return ExecResult(proc.returncode, proc.stdout, proc.stderr)


class AboxRunner:
    """Builds and drives a single abox sandbox run for a task bundle."""

    def __init__(
        self,
        *,
        abox_bin: str = "abox",
        template: str = "python",
        meta_mount: str = "/abox-meta",
        result_path: str = "/workspace/.agent/result.json",
        executor: Executor | None = None,
        scratch_root: Path | None = None,
    ) -> None:
        self._abox_bin = abox_bin
        self._template = template
        self._meta_mount = meta_mount
        self._result_path = result_path
        self._executor = executor or _subprocess_executor
        self._scratch_root = scratch_root

    def _write_bundle(self, bundle: TaskBundle, meta_dir: Path) -> None:
        meta_dir.mkdir(parents=True, exist_ok=True)
        (meta_dir / "agent.yaml").write_text(bundle.agent_yaml())
        (meta_dir / "objective.json").write_text(json.dumps(bundle.objective_json(), indent=2))
        (meta_dir / "bundle.json").write_text(
            json.dumps(bundle.model_dump(by_alias=True, mode="json"), indent=2)
        )

    def build_command(self, bundle: TaskBundle, meta_dir: Path) -> list[str]:
        """Construct the ``abox run`` argv (spec section 6.2)."""
        spec = bundle.agent_spec
        branch = ids.git_branch_for(bundle.run_id)
        return [
            self._abox_bin, "run",
            "--task", bundle.run_id,
            "--base", spec.sandbox.base_ref,
            "--branch", branch,
            "--timeout", str(spec.sandbox.timeout_seconds),
            "--template", spec.sandbox.profile or self._template,
            "--mount", f"{meta_dir}:{self._meta_mount}",
            "--",
            "agent-runner",
            "--bundle", f"{self._meta_mount}/bundle.json",
            "--result", self._result_path,
        ]

    def run(self, bundle: TaskBundle) -> AboxOutcome:
        scratch = Path(
            tempfile.mkdtemp(prefix=f"{bundle.run_id}-", dir=self._scratch_root)
        )
        meta_dir = scratch / "abox-meta"
        try:
            self._write_bundle(bundle, meta_dir)
            argv = self.build_command(bundle, meta_dir)
            exec_result = self._executor(argv)

            # abox surfaces the worktree result; in this scratch model the
            # executor is responsible for placing result.json under the mount.
            result = self._collect_result(meta_dir)
            return AboxOutcome(
                run_id=bundle.run_id,
                abox_task_id=bundle.run_id,
                exit_code=exec_result.exit_code,
                git_branch=ids.git_branch_for(bundle.run_id),
                result=result,
                changed_files=(result or {}).get("changed_files", []),
                stdout=exec_result.stdout,
                stderr=exec_result.stderr,
            )
        finally:
            if bundle.agent_spec.sandbox.ephemeral:
                shutil.rmtree(scratch, ignore_errors=True)

    @staticmethod
    def _collect_result(meta_dir: Path) -> dict | None:
        candidate = meta_dir / "result.json"
        if candidate.is_file():
            try:
                return json.loads(candidate.read_text())
            except json.JSONDecodeError:
                return None
        return None
