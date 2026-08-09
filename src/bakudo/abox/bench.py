"""Independent bench verification in a fresh sandbox (issue #28, OPT-3).

Winner selection is gated on *self-reported* ``bench_seconds_before/after``
metrics. Before a winner is trusted, its benchmark claim is re-measured here:
a fresh abox sandbox forks the base ref, times the bench command, applies the
winner's collected diff (the agent branch does not survive sandbox cleanup),
and times the bench again. Both timings happen in the same guest back to
back, so they are directly comparable.

The diff is model-authored code, so it is never executed host-side and the
verification guest gets ``--network safe`` (loopback only).
"""

from __future__ import annotations

import json
import shutil
import tempfile
from pathlib import Path

from .. import ids
from .runner import Executor, _subprocess_executor

# Wall clock granted beyond the guest bench work for boot/prepare/teardown.
_VERIFY_TIMEOUT_HEADROOM_SECONDS = 120

_MARKER = "verify_bench"

# Runs in-guest: time bench, apply the winner diff, time bench again. The
# bench command is shell-executed exactly as the attempt agent would run it.
_TIMER_TEMPLATE = """\
import json, subprocess, sys, time

bench = {bench!r}

def timed():
    start = time.perf_counter()
    proc = subprocess.run(bench, shell=True, cwd="/workspace",
                          capture_output=True, text=True)
    if proc.returncode != 0:
        sys.stderr.write(proc.stdout[-2000:] + proc.stderr[-2000:])
        sys.exit(f"bench command failed with exit {{proc.returncode}}")
    return time.perf_counter() - start

before = timed()
apply = subprocess.run(
    ["git", "apply", "/abox-meta/inputs/verify.patch"],
    cwd="/workspace", capture_output=True, text=True,
)
if apply.returncode != 0:
    sys.stderr.write(apply.stderr[-2000:])
    sys.exit("winner diff did not apply")
after = timed()
print(json.dumps({{"{marker}": {{"before": before, "after": after}}}}))
"""


def resolve_repo_path(repo: str, root: Path | str | None = None) -> Path:
    """Resolve a bare repo name to a host path (mirrors AboxRunner.resolve_repo)."""
    import os

    if root is None:
        env_root = os.environ.get("BAKUDO_REPO_ROOT")
        root = Path(env_root) if env_root else Path.cwd()
    root = Path(root)
    candidate = root / repo
    if (candidate / ".git").exists():
        return candidate
    return root


def abox_bench_measure(
    repo: Path | str,
    *,
    base_ref: str = "main",
    timeout: int = 600,
    abox_bin: str = "abox",
    executor: Executor | None = None,
):
    """Build a ``BenchMeasure`` bound to a repo (see control.optimize)."""
    repo = Path(repo)
    executor = executor or _subprocess_executor

    def measure(diff: str, bench_command: str) -> tuple[float, float]:
        if not diff.strip():
            raise ValueError("empty diff: nothing to verify")
        task = f"verify-{ids.run_id()[-12:]}"
        scratch = Path(tempfile.mkdtemp(prefix=f"{task}-"))
        try:
            patch = scratch / "verify.patch"
            patch.write_text(diff if diff.endswith("\n") else diff + "\n")
            timer = _TIMER_TEMPLATE.format(bench=bench_command, marker=_MARKER)
            argv = [
                abox_bin, "run",
                "--repo", str(repo),
                "--task", task,
                "--base", base_ref,
                "--timeout", str(timeout),
                "--network", "safe",
                "--input-file", f"{patch}:verify.patch",
                "--",
                "python3", "-c", timer,
            ]
            result = executor(argv, timeout + _VERIFY_TIMEOUT_HEADROOM_SECONDS)
            if result.exit_code != 0:
                raise RuntimeError(
                    f"bench verification sandbox failed (exit {result.exit_code}): "
                    f"{result.stderr[-2000:] or result.stdout[-2000:]}"
                )
            return _parse_marker(result.stdout)
        finally:
            try:
                executor(
                    [abox_bin, "stop", "--clean", task, "--repo", str(repo)], 120
                )
            except Exception:  # noqa: BLE001 - best-effort cleanup
                pass
            shutil.rmtree(scratch, ignore_errors=True)

    return measure


def _parse_marker(stdout: str) -> tuple[float, float]:
    for line in reversed(stdout.splitlines()):
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            data = json.loads(line)
        except json.JSONDecodeError:
            continue
        timings = data.get(_MARKER)
        if isinstance(timings, dict):
            return float(timings["before"]), float(timings["after"])
    raise RuntimeError(
        "bench verification produced no timing marker in guest stdout: "
        + stdout[-500:]
    )
