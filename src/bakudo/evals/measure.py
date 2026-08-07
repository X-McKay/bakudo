"""Harness-side measurement: benchmarks and complexity the *harness* runs (§22).

The optimize graders (:func:`~bakudo.evals.checks.perf_eval`,
:func:`~bakudo.evals.checks.simplicity_eval`) grade before/after metric pairs.
Trusting the agent to report those numbers makes the optimize loop's win
condition "the model claims it got faster" — so the worker harness measures
them itself, around the agent run, and **overwrites** whatever the agent wrote
into ``result.metrics``:

* ``bench_seconds_before/after`` — wall-clock median of N runs of the
  objective's ``constraints.benchCommand`` in the workspace.
* ``complexity_before/after`` — a deterministic, dependency-free complexity
  score over the objective's ``constraints.targetPaths`` (logical lines plus
  weighted branch points; only the *delta's direction* matters to the grader).

Harness-measured metrics carry ``metrics["harness_measured"] = 1.0`` so
downstream consumers can tell measured runs from self-reported ones.
"""

from __future__ import annotations

import re
import shlex
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path

from ..curriculum.objective import Objective
from ..runner.result import RunResult

# Median-of-N keeps a single noisy run from deciding an optimization's fate.
DEFAULT_BENCH_RUNS = 3
DEFAULT_BENCH_TIMEOUT_S = 300.0

# Branch points weigh more than plain statements; the constants are arbitrary
# but fixed — only the before/after direction feeds the simplicity gate.
_BRANCH_RE = re.compile(
    r"^\s*(if|elif|else\b|for|while|except|case\b|and\b|or\b)|(\band\b|\bor\b)"
)
_BRANCH_WEIGHT = 2.0


@dataclass
class BenchMeasurement:
    """One benchmark measurement: median wall-clock over ``runs`` executions."""

    median_seconds: float
    runs: list[float] = field(default_factory=list)
    ok: bool = True
    error: str = ""


def time_command(
    command: str,
    cwd: str | Path,
    *,
    runs: int = DEFAULT_BENCH_RUNS,
    warmup: int = 1,
    timeout_s: float = DEFAULT_BENCH_TIMEOUT_S,
) -> BenchMeasurement:
    """Time a benchmark command: median wall-clock of ``runs`` executions.

    ``warmup`` untimed executions run first — the initial run pays one-off
    costs (bytecode cache, filesystem cache) that would otherwise make every
    "before" measurement look slower than "after" on identical code. A
    non-zero exit or timeout marks the measurement not-ok (the caller then
    omits the metric rather than grading garbage). The command is split with
    shlex — no shell interpretation.
    """
    argv = shlex.split(command)
    samples: list[float] = []
    for i in range(max(1, runs) + max(0, warmup)):
        started = time.monotonic()
        try:
            proc = subprocess.run(
                argv, cwd=str(cwd), capture_output=True, text=True, timeout=timeout_s
            )
        except (subprocess.TimeoutExpired, OSError) as exc:
            return BenchMeasurement(0.0, samples, ok=False, error=str(exc)[:500])
        elapsed = time.monotonic() - started
        if proc.returncode != 0:
            return BenchMeasurement(
                0.0,
                samples,
                ok=False,
                error=(proc.stdout + proc.stderr)[-500:],
            )
        if i >= max(0, warmup):
            samples.append(elapsed)
    samples.sort()
    return BenchMeasurement(samples[len(samples) // 2], samples)


def complexity_of_source(text: str) -> float:
    """A deterministic complexity score for one file's source text."""
    score = 0.0
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        score += 1.0
        if _BRANCH_RE.match(stripped) or _BRANCH_RE.search(stripped):
            score += _BRANCH_WEIGHT
    return score


def measure_complexity(root: str | Path, target_globs: list[str]) -> float | None:
    """Sum complexity over the files matched by the objective's targetPaths.

    Returns ``None`` when no files match (the grader then treats the metric
    as unmeasured rather than pretending an empty target got simpler).
    """
    root = Path(root)
    matched: set[Path] = set()
    for pattern in target_globs:
        # Corpus globs use "dir/**" to mean "everything under dir", but
        # pathlib's "**" matches directories — expand to the file form too.
        patterns = [pattern]
        if pattern.endswith("**"):
            patterns.append(pattern + "/*")
        for expanded in patterns:
            for path in root.glob(expanded):
                if path.is_file() and path.suffix == ".py":
                    matched.add(path)
    if not matched:
        return None
    total = 0.0
    for path in sorted(matched):
        try:
            total += complexity_of_source(path.read_text(errors="ignore"))
        except OSError:
            continue
    return total


@dataclass
class Measurements:
    """One side (before or after) of the harness measurement pair."""

    bench_seconds: float | None = None
    complexity: float | None = None
    bench_error: str = ""


def capture_measurements(
    objective: Objective,
    workspace_root: str | Path,
    *,
    bench_runs: int = DEFAULT_BENCH_RUNS,
    bench_timeout_s: float = DEFAULT_BENCH_TIMEOUT_S,
) -> Measurements:
    """Measure whatever the objective's constraints declare, in the workspace."""
    out = Measurements()
    constraints = objective.constraints
    if constraints.bench_command:
        bench = time_command(
            constraints.bench_command,
            workspace_root,
            runs=bench_runs,
            timeout_s=bench_timeout_s,
        )
        if bench.ok:
            out.bench_seconds = bench.median_seconds
        else:
            out.bench_error = bench.error
    if constraints.target_paths:
        out.complexity = measure_complexity(workspace_root, constraints.target_paths)
    return out


def apply_measurements(
    result: RunResult, before: Measurements, after: Measurements
) -> RunResult:
    """Write harness measurements into ``result.metrics``, overriding agent claims.

    Only pairs where both sides measured cleanly are written; a broken
    benchmark drops the metric (and any agent-claimed value for it) so the
    grader sees "unmeasured" instead of fiction.
    """
    for key in (
        "bench_seconds_before",
        "bench_seconds_after",
        "complexity_before",
        "complexity_after",
    ):
        result.metrics.pop(key, None)

    measured = False
    if before.bench_seconds is not None and after.bench_seconds is not None:
        result.metrics["bench_seconds_before"] = before.bench_seconds
        result.metrics["bench_seconds_after"] = after.bench_seconds
        measured = True
    if before.complexity is not None and after.complexity is not None:
        result.metrics["complexity_before"] = before.complexity
        result.metrics["complexity_after"] = after.complexity
        measured = True
    if measured:
        result.metrics["harness_measured"] = 1.0
    return result
