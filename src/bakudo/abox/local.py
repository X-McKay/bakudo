"""A local, in-process sandbox used for tests and offline dry-runs.

This is **not** a security boundary — it runs the agent runner in the current
process against a throwaway git workspace. It exists so the end-to-end run
pipeline (bundle -> run -> result -> eval) can be exercised without abox
microVMs or a live model. Production runs always go through
:class:`bakudo.abox.runner.AboxRunner`.
"""

from __future__ import annotations

import json
import subprocess
import tempfile
from pathlib import Path

from .. import ids
from ..bundle import TaskBundle
from ..runner.agent import OfflineDriver, build_and_run
from ..runner.result import normalize_result
from ..skills import SkillRegistry
from ..strands_tools import ToolContext, Workspace
from .runner import AboxOutcome


def _git_init(path: Path) -> None:
    env_args = dict(check=True, cwd=path, capture_output=True, text=True)
    subprocess.run(["git", "init", "-q"], **env_args)
    subprocess.run(["git", "config", "user.email", "runner@bakudo"], **env_args)
    subprocess.run(["git", "config", "user.name", "bakudo-runner"], **env_args)
    # The throwaway workspace must not require commit signing.
    subprocess.run(["git", "config", "commit.gpgsign", "false"], **env_args)
    (path / ".gitkeep").write_text("")
    subprocess.run(["git", "add", "-A"], **env_args)
    subprocess.run(["git", "commit", "-q", "-m", "init"], **env_args)


def local_sandbox(
    bundle: TaskBundle,
    *,
    offline_driver: OfflineDriver | None = None,
    workspace_root: Path | None = None,
) -> AboxOutcome:
    """Run a bundle locally and return an :class:`AboxOutcome`."""
    if workspace_root is None:
        workspace_root = Path(tempfile.mkdtemp(prefix=f"{bundle.run_id}-ws-"))
        _git_init(workspace_root)

    spec = bundle.agent_spec
    workspace = Workspace(workspace_root)
    skills = SkillRegistry(allowed=spec.skills)
    ctx = ToolContext(
        workspace=workspace, skills=skills, run_id=bundle.run_id,
        memory_query=bundle.memory_query,
    )

    raw = build_and_run(spec, bundle, ctx, offline_driver=offline_driver)
    result = normalize_result(
        raw, run_id=bundle.run_id, agent=spec.ref, objective_id=bundle.objective_id
    )
    if not result.changed_files:
        result.changed_files = workspace.changed_files()
    if ctx.denied_commands:
        result.blocked_reasons.extend(f"denied:{d['reason']}" for d in ctx.denied_commands)

    return AboxOutcome(
        run_id=bundle.run_id,
        abox_task_id=bundle.run_id,
        exit_code=0 if result.status.value != "failed" else 1,
        git_branch=ids.git_branch_for(bundle.run_id),
        result=result.to_dict(),
        diff=workspace.git_diff(),
        changed_files=result.changed_files,
        denied_commands=list(ctx.denied_commands),
        stdout=json.dumps(result.to_dict()),
    )
