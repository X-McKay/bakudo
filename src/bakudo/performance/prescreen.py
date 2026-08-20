"""Untrusted host-side A/B prescreen for candidate go/no-go decisions.

A prescreen answers "is this candidate worth trusted guest time?" as cheaply
as possible: it runs the workload command on the host, interleaved across the
two pinned revisions, each checked out into a disposable detached git
worktree so the operator's checkout is never touched and uncommitted changes
can never ride along on either side.

A prescreen is NEVER comparison evidence. Nothing is persisted, the host
environment carries no pin, and the verdict vocabulary is deliberately
different from a :class:`~bakudo.performance.models.PerformanceComparison`:
``likely-improvement`` / ``likely-regression`` / ``unclear``, all meaning
"decide whether to spend trusted guest time", never "promote".
"""

from __future__ import annotations

import os
import statistics
import subprocess
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from tempfile import TemporaryDirectory

from .source import LoadedWorkload

# A command runner returns the wall-clock seconds of one workload invocation.
CommandRunner = Callable[[list[str], Path, Mapping[str, str], float], float]


class PrescreenError(RuntimeError):
    """The prescreen could not produce an interleaved host reading."""


@dataclass(frozen=True)
class PrescreenSide:
    ref: str
    commit_sha: str
    seconds: tuple[float, ...]

    @property
    def median(self) -> float:
        return statistics.median(self.seconds)


@dataclass(frozen=True)
class PrescreenResult:
    workload_ref: str
    baseline: PrescreenSide
    candidate: PrescreenSide

    @property
    def relative_delta(self) -> float:
        """Candidate median relative to baseline median (negative = faster)."""

        return (self.candidate.median - self.baseline.median) / self.baseline.median

    @property
    def verdict(self) -> str:
        # Only range non-overlap earns a "likely" call: medians alone are too
        # noisy on a shared host to justify steering the operator.
        if max(self.candidate.seconds) < min(self.baseline.seconds):
            return "likely-improvement"
        if min(self.candidate.seconds) > max(self.baseline.seconds):
            return "likely-regression"
        return "unclear"

    def to_dict(self) -> dict[str, object]:
        return {
            "kind": "HostPrescreen",
            "evidence": False,
            "workload": self.workload_ref,
            "baseline": {
                "ref": self.baseline.ref,
                "commitSHA": self.baseline.commit_sha,
                "seconds": list(self.baseline.seconds),
                "medianSeconds": self.baseline.median,
            },
            "candidate": {
                "ref": self.candidate.ref,
                "commitSHA": self.candidate.commit_sha,
                "seconds": list(self.candidate.seconds),
                "medianSeconds": self.candidate.median,
            },
            "relativeDelta": self.relative_delta,
            "verdict": self.verdict,
        }


def _git(repo: Path, *args: str) -> str:
    completed = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True)
    if completed.returncode != 0:
        raise PrescreenError(f"git {' '.join(args)} failed: {completed.stderr.strip()}")
    return completed.stdout.strip()


def _resolve_commit(repo: Path, ref: str) -> str:
    return _git(repo, "rev-parse", "--verify", f"{ref}^{{commit}}")


def _host_argv(workload: LoadedWorkload, python: str | None) -> list[str]:
    """Rewrite the pinned argv for a host run.

    Same safe-member test as the guest runners: only a plain relative
    workload-member reference is rewritten, here to its absolute path under
    the loaded workload's read-only directory.
    """

    argv: list[str] = []
    for index, argument in enumerate(workload.spec.command.argv):
        if index == 0 and python is not None and argument == "python3":
            argv.append(python)
            continue
        relative = PurePosixPath(argument)
        is_safe_member = (
            not argument.startswith("-")
            and "\\" not in argument
            and not relative.is_absolute()
            and ".." not in relative.parts
            and "." not in relative.parts
            and relative.as_posix() == argument
            and (workload.root / relative).exists()
        )
        argv.append(str(workload.root / relative) if is_safe_member else argument)
    return argv


def _timed_subprocess(argv: list[str], cwd: Path, env: Mapping[str, str], timeout: float) -> float:
    started = time.perf_counter()
    completed = subprocess.run(
        argv, cwd=cwd, env=dict(env), capture_output=True, text=True, timeout=timeout
    )
    elapsed = time.perf_counter() - started
    if completed.returncode != 0:
        raise PrescreenError(
            f"workload command exited {completed.returncode}: {completed.stderr[-500:]}"
        )
    return elapsed


def run_prescreen(
    repo: Path,
    workload: LoadedWorkload,
    baseline_ref: str,
    candidate_ref: str,
    *,
    runs: int = 6,
    warmups: int = 1,
    python: str | None = None,
    runner: CommandRunner = _timed_subprocess,
) -> PrescreenResult:
    if runs < 2:
        raise PrescreenError("a prescreen needs at least 2 interleaved runs per side")
    shas = {
        "baseline": _resolve_commit(repo, baseline_ref),
        "candidate": _resolve_commit(repo, candidate_ref),
    }
    argv = _host_argv(workload, python)
    env = dict(os.environ)
    env.update(workload.spec.command.env)
    env["BAKUDO_WORKLOAD_DIR"] = str(workload.root)
    timeout = float(workload.spec.measurement.timeout_seconds)

    with TemporaryDirectory(prefix="bakudo-prescreen-") as scratch:
        cwds: dict[str, Path] = {}
        try:
            for side, sha in shas.items():
                worktree = Path(scratch) / side
                _git(repo, "worktree", "add", "--detach", str(worktree), sha)
                cwds[side] = (worktree / workload.spec.command.cwd).resolve()

            samples: dict[str, list[float]] = {"baseline": [], "candidate": []}
            for _ in range(warmups):
                for side in ("baseline", "candidate"):
                    runner(argv, cwds[side], env, timeout)
            for round_index in range(runs):
                order = (
                    ("baseline", "candidate") if round_index % 2 == 0 else ("candidate", "baseline")
                )
                for side in order:
                    samples[side].append(runner(argv, cwds[side], env, timeout))
        finally:
            for side in cwds:
                _git(repo, "worktree", "remove", "--force", str(Path(scratch) / side))

    return PrescreenResult(
        workload_ref=workload.ref,
        baseline=PrescreenSide(baseline_ref, shas["baseline"], tuple(samples["baseline"])),
        candidate=PrescreenSide(candidate_ref, shas["candidate"], tuple(samples["candidate"])),
    )
