"""Hidden-test evaluation: fail-to-pass / pass-to-pass rates for a diff.

A trial's diff is graded against the scenario's ``hidden/`` tests, which are
never materialized into the agent's own workspace (see
:mod:`bakudo.scenarios.provision`). ``evaluate`` provisions a *fresh*,
throwaway workspace, applies the candidate diff to it with ``git apply``
only (never by executing anything from the diff or the fixture directly),
copies in the relevant hidden test file, and delegates execution to the
injected ``runner`` -- exactly the same boundary the verify loop (Task 5)
uses, so a hidden eval can never leak into, or be tampered with by, the
workspace the agent under test actually touched.
"""

from __future__ import annotations

import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

from ..scenarios.provision import provision
from ..scenarios.registry import LoadedScenario
from ..scenarios.testrun import TestRunner


@dataclass
class HiddenOutcome:
    f2p_rate: float
    p2p_rate: float
    reward: dict[str, float]
    detail: str


def _ensure_conftest(repo_path: Path) -> None:
    """Anchor ``sys.path`` at the workspace root for copied-in hidden tests.

    Same fix as ``scenarios.verify._ensure_conftest`` (Task 5 lesson):
    pytest's default import mode roots on a test file's basedir, not the
    invocation cwd, so ``hidden/test_x.py`` can't ``import <fixture module>``
    without an (empty, if none already exists) ``conftest.py`` at the repo
    root.
    """
    conftest = repo_path / "conftest.py"
    if not conftest.exists():
        conftest.write_text("")


def _apply_diff(repo_path: Path, diff: str, scratch: Path) -> str | None:
    """Apply ``diff`` to ``repo_path`` via ``git apply``.

    A blank/whitespace-only diff is a deliberate no-op (valid for a
    no-change scenario, and for a candidate that made no edits) -- the apply
    step is skipped entirely rather than shelling out on empty input.
    Returns an error detail string on failure, else ``None``.
    """
    if not diff.strip():
        return None
    patch_path = scratch / "candidate.patch"
    patch_path.write_text(diff)
    try:
        subprocess.run(
            ["git", "apply", str(patch_path.resolve())],
            cwd=repo_path,
            check=True,
            capture_output=True,
            text=True,
        )
    except subprocess.CalledProcessError as exc:
        return ((exc.stdout or "") + (exc.stderr or "")).strip() or str(exc)
    return None


def _run_hidden_list(
    scenario: LoadedScenario, repo_path: Path, rel_paths: list[str], runner: TestRunner
) -> tuple[int, list[str]]:
    """Run each hidden test file in ``rel_paths`` and return (passed, failing).

    Mirrors ``scenarios.verify``'s ``_run_one_hidden_test`` handling: a
    runner that raises (a hung/killed subprocess, or any other OS-level
    failure) scores that one file as failed rather than crashing the whole
    evaluation -- a single flaky/hostile hidden test must never take down
    ``run_trial``.
    """
    hidden_dir = repo_path / "hidden"
    hidden_dir.mkdir(exist_ok=True)
    passed = 0
    failing: list[str] = []
    for rel in rel_paths:
        src = scenario.path / rel
        name = Path(rel).name
        shutil.copy2(src, hidden_dir / name)
        command = scenario.spec.hidden.test_command.format(files=f"hidden/{name}")
        try:
            result = runner(repo_path, command)
        except subprocess.CalledProcessError as exc:
            detail = ((exc.stdout or "") + (exc.stderr or "")).strip() or str(exc)
            failing.append(f"{rel} (error: {detail})")
            continue
        except subprocess.TimeoutExpired as exc:
            failing.append(f"{rel} (timed out: {exc})")
            continue
        except OSError as exc:
            failing.append(f"{rel} (runner error: {exc})")
            continue
        if result.passed:
            passed += 1
        else:
            failing.append(rel)
    return passed, failing


def _rate(passed: int, total: int) -> float:
    return 1.0 if total == 0 else passed / total


def evaluate(scenario: LoadedScenario, diff: str, seed: int, runner: TestRunner) -> HiddenOutcome:
    """Grade ``diff`` against ``scenario``'s hidden failToPass/passToPass tests.

    Provisions a fresh workspace (independent of whatever workspace the
    candidate diff was produced in), applies ``diff`` with ``git apply``,
    then runs each hidden test file through ``runner``. Rates are
    passed/total per list; an empty list scores 1.0 (vacuously satisfied --
    e.g. a no-change scenario's empty ``failToPass``).
    """
    with tempfile.TemporaryDirectory(prefix="bakudo-hidden-") as tmp:
        scratch = Path(tmp)
        ws = provision(scenario, scratch, seed=seed)
        repo_path = ws.repo_path

        apply_error = _apply_diff(repo_path, diff, scratch)
        if apply_error is not None:
            fail_total = len(scenario.spec.hidden.fail_to_pass)
            pass_total = len(scenario.spec.hidden.pass_to_pass)
            f2p_rate = _rate(0, fail_total)
            p2p_rate = _rate(0, pass_total)
            return HiddenOutcome(
                f2p_rate=f2p_rate,
                p2p_rate=p2p_rate,
                reward={"fail_to_pass_rate": f2p_rate, "pass_to_pass_rate": p2p_rate},
                detail=f"diff failed to apply: {apply_error}",
            )

        _ensure_conftest(repo_path)

        f2p_passed, f2p_failing = _run_hidden_list(
            scenario, repo_path, scenario.spec.hidden.fail_to_pass, runner
        )
        p2p_passed, p2p_failing = _run_hidden_list(
            scenario, repo_path, scenario.spec.hidden.pass_to_pass, runner
        )

        f2p_rate = _rate(f2p_passed, len(scenario.spec.hidden.fail_to_pass))
        p2p_rate = _rate(p2p_passed, len(scenario.spec.hidden.pass_to_pass))

        detail_parts = []
        if f2p_failing:
            detail_parts.append(f"failToPass still failing: {f2p_failing}")
        if p2p_failing:
            detail_parts.append(f"passToPass regressed: {p2p_failing}")
        detail = "; ".join(detail_parts) if detail_parts else "all hidden tests as expected"

        return HiddenOutcome(
            f2p_rate=f2p_rate,
            p2p_rate=p2p_rate,
            reward={"fail_to_pass_rate": f2p_rate, "pass_to_pass_rate": p2p_rate},
            detail=detail,
        )
