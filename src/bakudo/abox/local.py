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
import time
from pathlib import Path

from .. import ids
from ..bundle import TaskBundle
from ..runner.agent import OfflineDriver, build_and_run
from ..runner.result import normalize_result
from ..skills import SkillRegistry
from ..strands_tools import ToolContext, Workspace
from .runner import AboxOutcome


def _git(path: Path, *args: str) -> None:
    subprocess.run(["git", *args], check=True, cwd=path, capture_output=True, text=True)


def _git_init(path: Path) -> None:
    _git(path, "init", "-q")
    _git(path, "config", "user.email", "runner@bakudo")
    _git(path, "config", "user.name", "bakudo-runner")
    # The throwaway workspace must not require commit signing.
    _git(path, "config", "commit.gpgsign", "false")
    (path / ".gitkeep").write_text("")
    _git(path, "add", "-A")
    _git(path, "commit", "-q", "-m", "init")


def _under_temp_root(path: Path) -> bool:
    """Whether ``path`` resolves under the system temp root (F5 fix).

    Both sides are ``resolve()``d so a symlinked temp dir (common on macOS,
    where ``/tmp`` -> ``/private/tmp``) or a relative/``..``-laden input
    still compares correctly. Any resolution failure (e.g. a broken symlink)
    fails closed -- not under the temp root, so the caller falls back to a
    fresh scratch repo rather than risking an in-place reuse it can't verify.
    """
    try:
        return path.resolve().is_relative_to(Path(tempfile.gettempdir()).resolve())
    except (OSError, ValueError):
        return False


def local_sandbox(
    bundle: TaskBundle,
    *,
    offline_driver: OfflineDriver | None = None,
    workspace_root: Path | None = None,
    cancel_event: object | None = None,
) -> AboxOutcome:
    """Run a bundle locally and return an :class:`AboxOutcome`.

    ``cancel_event`` is accepted for interface parity with the abox runner but
    ignored: the local dev sandbox runs the agent in-process and is not
    interruptible mid-run (it is a dev/test affordance, not a real boundary).

    When no explicit ``workspace_root`` is given, ``bundle.objective.repo``
    is checked for an absolute path to an already-provisioned git workspace
    (e.g. :func:`bakudo.scenarios.provision.provision`'s output, wired in by
    :func:`bakudo.trials.runner.objective_from_scenario` /
    ``bakudo.temporal._impl.provision_trial``) and used in place rather than
    discarded in favor of a fresh, empty throwaway repo -- mirroring
    :meth:`bakudo.abox.runner.AboxRunner.resolve_repo`'s own absolute-path
    parity (an absolute ``objective.repo`` there is returned verbatim by
    pathlib's ``root / objective.repo`` regardless of ``root``). Without
    this, a dev-mode sandbox run against a real fixture would silently run
    against nothing: the agent edits (if any) land in an unrelated empty
    repo, and the diff collected back is never the diff the caller expected.
    Used in place, not copied: this branch only ever fires for a workspace
    nothing else reads concurrently (each provisioning call gets its own
    fresh scratch directory), and this function never resets/wipes an
    existing ``workspace_root`` (only the "create a fresh scratch repo"
    branch below does that) -- the same "in place" contract every explicit
    ``workspace_root=`` caller (the CLI's trial/experiment commands) already
    relies on.

    F5 fix: in-place reuse is further gated to paths that resolve under the
    system temp root (``tempfile.gettempdir()``) -- exactly where every
    trial/experiment provisioner (``scenarios.provision.provision``,
    ``trials.runner.run_trial``'s ``TemporaryDirectory``,
    ``temporal._impl.provision_trial``'s ``mkdtemp``) actually writes its
    scratch workspaces. Without this, ANY absolute, ``.git``-bearing
    ``objective.repo`` was reused in place -- including a dev-mode observer
    objective that happened to point at a real, non-scratch checkout on disk
    -- which would let the agent mutate that checkout directly instead of a
    disposable copy. A path outside the temp root always falls through to
    the fresh-scratch-repo branch below, same as a non-``.git`` path.
    """
    if workspace_root is None:
        repo = Path(bundle.objective.repo)
        if repo.is_absolute() and (repo / ".git").is_dir() and _under_temp_root(repo):
            workspace_root = repo
        else:
            workspace_root = Path(tempfile.mkdtemp(prefix=f"{bundle.run_id}-ws-"))
            _git_init(workspace_root)

    spec = bundle.agent_spec
    workspace = Workspace(workspace_root)
    skills = SkillRegistry(allowed=spec.skills)
    ctx = ToolContext(
        workspace=workspace, skills=skills, run_id=bundle.run_id,
        memory_query=bundle.memory_query,
    )

    started = time.monotonic()
    raw = build_and_run(spec, bundle, ctx, offline_driver=offline_driver)
    runtime_seconds = time.monotonic() - started
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
        runtime_seconds=runtime_seconds,
        tokens_used=ctx.tokens_used,
        observability=ctx.observability(),
        stdout=json.dumps(result.to_dict()),
    )
