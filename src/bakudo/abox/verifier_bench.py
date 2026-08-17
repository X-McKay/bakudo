"""abox-backed verifier-test runner (experiment-substrate follow-up, Task 8).

Grades a task's verifier test files inside a real abox guest instead of on
the host. Satisfies :data:`bakudo.tasks.verifier_runner.VerifierRunner`
(``Callable[[Path, str], VerificationResult]``) so it drops straight into
:func:`bakudo.trials.verifier.evaluate` and everywhere else a ``VerifierRunner`` is
threaded through -- the same boundary ``local_verifier_runner`` satisfies for
``BAKUDO_ENV=dev``, but backed by a real microVM instead of the host process.

Follows :mod:`bakudo.abox.bench`'s guest-invocation pattern exactly:

* ``abox run --repo <workspace> --base <ref> --network safe`` -- ``safe``
  because the workspace can hold agent-authored diff content (
  :mod:`bakudo.trials.verifier` applies a candidate's diff before calling this,
  same as the winner diff bench.py verifies);
* the guest command chains the repo's ``.abox/prepare.sh`` (when present)
  into the actual test command, prepare output routed to stderr so it can
  never collide with anything read from stdout;
* the command itself rides as its own argv element (``$1`` to an inner
  ``sh -c``) rather than being interpolated into the outer shell script --
  the same no-quoting-hazards reasoning as bench.py's timer source.

Unlike bench.py -- which forks a *worktree* off a long-lived dev repo and
must carefully clean up the branch/worktree it creates there -- the
workspace handed in here is already a throwaway, temp-rooted scratch repo
(see :mod:`bakudo.trials.verifier`, :mod:`bakudo.tasks.provision`): nobody
else reads it and the whole directory is discarded by the caller once
``evaluate()`` returns. So there is no host-side git state to protect: the
applied diff and copied-in verifier test file (both still uncommitted when
this runner is called -- ``git apply`` and ``shutil.copy2`` never commit) are
simply committed in place, with a fixed synthetic identity, to produce a ref
abox can fork -- that commit is never cleaned up, the caller's directory
removal handles it. Only the abox *sandbox* itself is torn down
(``abox stop --clean``), same as bench.py/runner.py's unconditional cleanup.

Unlike ``bench.py`` (which times a command and parses a JSON marker), grading
only needs exit code + a tail of guest console output -- no marker protocol.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

from .. import ids
from ..tasks.verifier_runner import VerificationResult, VerifierRunner
from .runner import (
    IN_GUEST_SETUP_HEADROOM_SECONDS,
    SUBPROCESS_TIMEOUT_HEADROOM_SECONDS,
    Executor,
    _subprocess_executor,
)

# Where a workspace's prepare script would live inside the guest -- mirrors
# abox/runner.py's _GUEST_PREPARE_SCRIPT (every abox run in this codebase
# mounts its repo at /workspace).
_GUEST_PREPARE_SCRIPT = "/workspace/.abox/prepare.sh"

# Trailing characters of guest console output kept in the VerificationResult:
# enough for a pytest failure summary, bounded so a runaway/verbose test
# can't blow up the TrialRecord/ledger row it eventually lands in.
_TAIL_CHARS = 8_000

# Guest work budget for a single verifier-test-file command. Guest boot +
# prepare share the same abox --timeout deadline (IN_GUEST_SETUP_HEADROOM_
# SECONDS is added on top, same as every other abox invocation here).
_DEFAULT_TIMEOUT_SECONDS = 300

# Fixed, synthetic identity for the in-place snapshot commit -- this
# workspace is a disposable scratch repo, never a shared one, so there is no
# "real" author to record; the constants just keep `git commit` happy
# without depending on host git config (which may have none).
_COMMIT_ENV = {
    "GIT_AUTHOR_NAME": "bakudo-verifier-eval",
    "GIT_AUTHOR_EMAIL": "verifier-eval@bakudo.invalid",
    "GIT_COMMITTER_NAME": "bakudo-verifier-eval",
    "GIT_COMMITTER_EMAIL": "verifier-eval@bakudo.invalid",
    "GIT_CONFIG_GLOBAL": "/dev/null",
    "GIT_CONFIG_SYSTEM": "/dev/null",
}


class AboxVerifierEvalError(RuntimeError):
    """The workspace couldn't be readied for grading (e.g. not a git repo)."""


# Task fixtures are deliberately dependency-free (Task 4: hand-written,
# stdlib-only except for pytest itself -- verified across the whole corpus)
# and never ship their own ``.abox/`` config, so the default abox guest (the
# "base" profile, no python3 at all -- confirmed live) can't run their
# verifier tests. A workspace that already declares its own environment (e.g.
# a dogfood run against bakudo's own checkout, which has a real
# ``.abox/project.toml``) is left completely alone; this is a bootstrap of
# last resort, only written when nothing else claims the ``.abox/``
# directory. Content is fixed so the abox approval fingerprint never
# changes: a one-time ``abox project trust`` on this exact synthetic content
# (documented alongside the other live-e2e prerequisites) covers every
# future ephemeral verifier-eval workspace, not just this one.
_SYNTHETIC_PROJECT_TOML = """\
[project]
id = "bakudo-verifier-eval"

[environment]
profile = "python-glibc"
prepare = ".abox/prepare.sh"
"""

_SYNTHETIC_PREPARE_SH = """\
#!/bin/sh
# Synthesized by bakudo.abox.verifier_bench (Task 8): the workspace has no
# .abox/ of its own, so nothing else would put pytest in this guest.
set -eu
python3 -m pytest --version >/dev/null 2>&1 && exit 0
python3 -m pip install --quiet --break-system-packages pytest 2>/dev/null \\
  || python3 -m pip install --quiet pytest
"""


def _ensure_guest_environment(workspace: Path) -> None:
    """Synthesize a minimal python-glibc ``.abox/`` (project.toml + a
    pytest-bootstrapping prepare.sh) when ``workspace`` doesn't already have
    one of its own. Never overwrites an existing ``.abox/project.toml``.
    """
    project_toml = workspace / ".abox" / "project.toml"
    if project_toml.exists():
        return
    project_toml.parent.mkdir(parents=True, exist_ok=True)
    project_toml.write_text(_SYNTHETIC_PROJECT_TOML)
    prepare_sh = project_toml.parent / "prepare.sh"
    prepare_sh.write_text(_SYNTHETIC_PREPARE_SH)
    prepare_sh.chmod(0o755)


def _git(cwd: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args],
        cwd=cwd,
        env={**os.environ, **_COMMIT_ENV},
        capture_output=True,
        text=True,
        timeout=120,
    )


def _snapshot_ref(workspace: Path) -> str:
    """Commit whatever is currently on disk in ``workspace`` and return the
    resulting commit sha for use as abox's ``--base``.

    abox forks a worktree from a git *ref*; it does not see a repo's dirty
    working tree (the same reason bench.py commits the winner diff onto a
    branch host-side before ever invoking abox -- see its module docstring).
    The applied diff and freshly copied-in verifier test file are both still
    uncommitted at this point (``git apply`` and ``shutil.copy2`` never
    commit); a synthetic guest environment is added if the workspace has
    none (:func:`_ensure_guest_environment`); everything is then committed
    here, in place -- no branch, no cleanup needed since the whole workspace
    is scratch.
    """
    _ensure_guest_environment(workspace)
    add = _git(workspace, "add", "-A")
    if add.returncode != 0:
        raise AboxVerifierEvalError(
            f"could not snapshot verifier-eval workspace {workspace} for abox "
            f"(git add failed): {add.stderr[-1000:]}"
        )
    commit = _git(workspace, "commit", "-q", "--allow-empty", "-m", "verifier-eval snapshot")
    if commit.returncode != 0:
        raise AboxVerifierEvalError(
            f"could not snapshot verifier-eval workspace {workspace} for abox "
            f"(git commit failed): {commit.stderr[-1000:]}"
        )
    rev = _git(workspace, "rev-parse", "HEAD")
    if rev.returncode != 0:
        raise AboxVerifierEvalError(
            f"could not resolve verifier-eval snapshot commit in {workspace}: {rev.stderr[-1000:]}"
        )
    return rev.stdout.strip()


def _tail(text: str) -> str:
    return text[-_TAIL_CHARS:]


def make_abox_verifier_runner(
    *,
    abox_bin: str = "abox",
    executor: Executor | None = None,
    timeout: int = _DEFAULT_TIMEOUT_SECONDS,
) -> VerifierRunner:
    """Build a :data:`VerifierRunner` that grades ``command`` inside a fresh abox
    guest with ``workspace`` mounted as its repo.

    ``executor`` defaults to the real subprocess-driving abox CLI
    (:func:`bakudo.abox.runner._subprocess_executor`); tests inject a fake
    (``tests/test_verifier_bench.py``, mirroring ``tests/test_abox_bench.py``'s
    pattern).
    """
    exec_fn: Executor = executor or _subprocess_executor

    def _run(workspace: Path, command: str) -> VerificationResult:
        # Fail-closed guard identical in spirit to local_verifier_runner's own
        # BAKUDO_ENV=dev check: callers (Deps.verifier_eval_fn's resolution
        # ladder, the CLI's trial/experiment commands) already gate on this
        # before ever selecting abox_verifier_runner, but a runner that
        # independently refuses to drive a sandbox outside its declared
        # posture is cheap insurance against a future call site skipping
        # that gate.
        if os.environ.get("BAKUDO_SANDBOX") != "abox":
            raise RuntimeError(
                "abox_verifier_runner executes verifier tests inside a real abox "
                "guest and requires BAKUDO_SANDBOX=abox; set it to opt in "
                "(or use local_verifier_runner under BAKUDO_ENV=dev instead)."
            )

        base_ref = _snapshot_ref(workspace)
        task = f"verifier-{ids.run_id()[-12:]}"
        guest_timeout = timeout + IN_GUEST_SETUP_HEADROOM_SECONDS
        # The command rides as its own argv element ($1 to the inner
        # `sh -c`), never interpolated into the outer script string -- no
        # quoting hazards, mirrors bench.py's timer-source handling. PATH
        # picks up `pip install --user`'s bin dir (confirmed live: pip puts
        # console scripts like pytest there, and it is NOT on the guest's
        # default PATH) -- harmless when unused (a repo-owned prepare.sh
        # that installs into site-packages instead).
        guest_script = (
            "set -e; "
            f"[ ! -f {_GUEST_PREPARE_SCRIPT} ] || sh {_GUEST_PREPARE_SCRIPT} >&2; "
            'export PATH="$HOME/.local/bin:$PATH"; '
            'exec sh -c "$1"'
        )
        argv = [
            abox_bin,
            "run",
            "--repo",
            str(workspace),
            "--task",
            task,
            "--base",
            base_ref,
            "--timeout",
            str(guest_timeout),
            "--network",
            "safe",  # workspace may hold agent-authored diff content
            "--",
            "sh",
            "-c",
            guest_script,
            "sh",
            command,
        ]
        try:
            result = exec_fn(argv, guest_timeout + SUBPROCESS_TIMEOUT_HEADROOM_SECONDS)
        finally:
            try:
                exec_fn([abox_bin, "stop", "--clean", task, "--repo", str(workspace)], 120)
            except Exception:  # noqa: BLE001 - best-effort cleanup
                pass

        output = _tail(result.stdout or "") + _tail(result.stderr or "")
        return VerificationResult(
            passed=result.exit_code == 0, exit_code=result.exit_code, output=output
        )

    return _run


# The production default: real subprocess executor, real abox binary. Every
# non-test caller (Deps.verifier_eval_fn's resolution ladder, the CLI) imports
# this name directly -- mirrors local_verifier_runner being a plain function
# rather than something callers must construct.
abox_verifier_runner: VerifierRunner = make_abox_verifier_runner()
