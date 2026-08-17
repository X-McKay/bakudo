"""Verifier execution boundary for task authoring and trial evaluation.

A ``VerifierRunner`` runs a command inside a provisioned workspace and
reports whether it succeeded. ``local_verifier_runner`` is the development
implementation used by ``bakudo task verify`` and local contract tests: it
shells out on the *host* running Bakudo, which means it executes
whatever code lives in a task's ``fixture/`` tree (and, transitively,
anything a candidate agent's patch adds to it). A production trial must
therefore use a sandbox-backed implementation, so
this runner is guarded behind an explicit ``BAKUDO_ENV=dev`` opt-in and must
never be wired into anything that evaluates untrusted agent output.
"""

from __future__ import annotations

import os
import subprocess
import sys
from collections.abc import Callable
from pathlib import Path
from typing import NamedTuple


class VerificationResult(NamedTuple):
    passed: bool
    exit_code: int
    output: str


VerifierRunner = Callable[[Path, str], "VerificationResult"]


def local_verifier_runner(workspace: Path, command: str) -> VerificationResult:
    """Run ``command`` in ``workspace`` on the local host and report the
    result.

    Guarded: raises ``RuntimeError`` unless ``BAKUDO_ENV=dev`` is set, so it
    can only ever run as part of an explicit local dev-loop invocation
    (task authoring, ``bakudo task verify``, this package's own
    tests) and never as a silent default for evaluating agent-authored code.
    """
    if os.environ.get("BAKUDO_ENV") != "dev":
        raise RuntimeError(
            "local_verifier_runner executes task fixture/agent code directly "
            "on this host and is only for local dev-loop verification; set "
            "BAKUDO_ENV=dev to allow it."
        )
    result = subprocess.run(
        command,
        shell=True,
        cwd=workspace,
        env={
            **os.environ,
            "PATH": f"{Path(sys.executable).parent}{os.pathsep}{os.environ.get('PATH', '')}",
        },
        timeout=120,
        capture_output=True,
        text=True,
    )
    output = (result.stdout or "") + (result.stderr or "")
    return VerificationResult(
        passed=result.returncode == 0, exit_code=result.returncode, output=output
    )
