"""Test execution for the scenario verify loop.

A ``TestRunner`` runs a shell command inside a provisioned workspace and
reports whether it succeeded. ``local_test_runner`` is the reference
implementation used by ``bakudo scenario verify`` and the exemplar test
suite: it shells out on the *host* running bakudo, which means it executes
whatever code lives in a scenario's ``fixture/`` tree (and, transitively,
anything a candidate agent's patch adds to it). That is exactly what the
sandboxed trial runner (Task 7) must never do outside a real sandbox, so
this runner is guarded behind an explicit ``BAKUDO_ENV=dev`` opt-in and must
never be wired into anything that evaluates untrusted agent output.
"""

from __future__ import annotations

import os
import subprocess
from collections.abc import Callable
from pathlib import Path
from typing import NamedTuple


class TestRunResult(NamedTuple):
    passed: bool
    exit_code: int
    output: str


TestRunner = Callable[[Path, str], "TestRunResult"]


def local_test_runner(workspace: Path, command: str) -> TestRunResult:
    """Run ``command`` in ``workspace`` on the local host and report the
    result.

    Guarded: raises ``RuntimeError`` unless ``BAKUDO_ENV=dev`` is set, so it
    can only ever run as part of an explicit local dev-loop invocation
    (scenario authoring, ``bakudo scenario verify``, this package's own
    tests) and never as a silent default for evaluating agent-authored code.
    """
    if os.environ.get("BAKUDO_ENV") != "dev":
        raise RuntimeError(
            "local_test_runner executes scenario fixture/agent code directly "
            "on this host and is only for local dev-loop verification; set "
            "BAKUDO_ENV=dev to allow it."
        )
    result = subprocess.run(
        command,
        shell=True,
        cwd=workspace,
        timeout=120,
        capture_output=True,
        text=True,
    )
    output = (result.stdout or "") + (result.stderr or "")
    return TestRunResult(passed=result.returncode == 0, exit_code=result.returncode, output=output)
