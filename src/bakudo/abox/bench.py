"""Independent bench verification in a fresh sandbox (issue #28, OPT-3).

Winner selection is gated on *self-reported* ``bench_seconds_before/after``
metrics. Before a winner is trusted, its benchmark claim is re-measured here:
a fresh abox sandbox forks the base ref, times the bench command, applies the
winner's collected diff (the agent branch does not survive sandbox cleanup),
and times the bench again. Both timings happen in the same guest back to
back, so they are directly comparable.

The diff is model-authored code, so it is never executed host-side and the
verification guest gets ``--network safe`` (host-mediated egress only).

Under abox 0.7.0 every sandbox boots a fresh OCI guest (warm persists caches
only), so each verification guest first runs the target repo's
``.abox/prepare.sh`` — routed to stderr so pip output can never collide with
the stdout timing marker — before timing the bench command.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
from pathlib import Path

from .. import ids
from .runner import (
    IN_GUEST_SETUP_HEADROOM_SECONDS,
    SUBPROCESS_TIMEOUT_HEADROOM_SECONDS,
    Executor,
    _subprocess_executor,
)

# Wall clock granted beyond the guest deadline for image pull, the host-side
# auto-warm refresh, boot, and teardown — same budget the runner grants, and
# for the same reason: a cold warm refresh under 0.7.0 can take minutes.
_VERIFY_TIMEOUT_HEADROOM_SECONDS = SUBPROCESS_TIMEOUT_HEADROOM_SECONDS

_MARKER = "verify_bench"

# Runs in-guest: time the bench command once (shell-executed exactly as the
# attempt agent would run it) and print the marker. The winner diff is applied
# HOST-side onto a temporary verification branch beforehand — abox's in-guest
# command proxy denies mutating git ops like `git apply` (verified live).
_TIMER_TEMPLATE = """\
import json, subprocess, sys, time

bench = {bench!r}
timings = []
for _ in range({repeats}):
    start = time.perf_counter()
    proc = subprocess.run(bench, shell=True, cwd="/workspace",
                          capture_output=True, text=True)
    timings.append(time.perf_counter() - start)
    if proc.returncode != 0:
        sys.stderr.write(proc.stdout[-2000:] + proc.stderr[-2000:])
        sys.exit(f"bench command failed with exit {{proc.returncode}}")
print(json.dumps({{"{marker}": {{"seconds": min(timings)}}}}))
"""

# Best-of-N per ref: wall-clock timing carries interpreter-startup and cache
# noise (~60ms floor) that compresses large speedups and can false-fail
# micro-benches near the verification threshold; the minimum is the stable
# estimator of a command's true cost.
_BENCH_REPEATS = 3


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

    def _bench_once(task: str, ref: str, bench_command: str) -> float:
        timer = _TIMER_TEMPLATE.format(
            bench=bench_command, marker=_MARKER, repeats=_BENCH_REPEATS
        )
        # The timer source is passed as a separate argv element ($1), never
        # interpolated into the shell script — no quoting hazards. Prepare
        # output goes to stderr so pip logs cannot fake the stdout marker.
        guest_timeout = timeout + IN_GUEST_SETUP_HEADROOM_SECONDS
        argv = [
            abox_bin, "run",
            "--repo", str(repo),
            "--task", task,
            "--base", ref,
            "--timeout", str(guest_timeout),
            "--network", "safe",
            "--",
            "sh", "-c",
            "set -e; "
            "[ ! -f /workspace/.abox/prepare.sh ] || sh /workspace/.abox/prepare.sh >&2; "
            'exec python3 -c "$1"',
            "sh", timer,
        ]
        try:
            result = executor(argv, guest_timeout + _VERIFY_TIMEOUT_HEADROOM_SECONDS)
            if result.exit_code != 0:
                # Guest console interleaves into abox stdout; the actionable
                # failure text is as likely there as on stderr.
                raise RuntimeError(
                    f"bench verification sandbox failed (exit {result.exit_code}): "
                    f"stdout: {result.stdout[-1500:]} stderr: {result.stderr[-1500:]}"
                )
            return _parse_marker(result.stdout)
        finally:
            try:
                executor(
                    [abox_bin, "stop", "--clean", task, "--repo", str(repo)], 120
                )
            except Exception:  # noqa: BLE001 - best-effort cleanup
                pass

    def measure(diff: str, bench_command: str) -> tuple[float, float]:
        if not diff.strip():
            raise ValueError("empty diff: nothing to verify")
        verify_id = ids.run_id()[-12:]
        branch = f"verify/{verify_id}"
        scratch = Path(tempfile.mkdtemp(prefix=f"verify-{verify_id}-"))
        worktree = scratch / "worktree"
        try:
            patch = scratch / "verify.patch"
            patch.write_text(diff if diff.endswith("\n") else diff + "\n")
            # Host-side: materialise the winner's state on a temp branch. This
            # only writes file content — nothing from the diff is executed.
            _git(repo, "worktree", "add", "-b", branch, str(worktree), base_ref)
            _git(worktree, "apply", str(patch))
            _git(worktree, "add", "-A")
            _git(worktree, "-c", "user.email=bakudo@verify", "-c",
                 "user.name=bakudo-verify", "commit", "-q", "-m",
                 "bench verification candidate")
            before = _bench_once(f"verify-b-{verify_id}", base_ref, bench_command)
            after = _bench_once(f"verify-a-{verify_id}", branch, bench_command)
            return before, after
        finally:
            for args in (
                ("worktree", "remove", "--force", str(worktree)),
                ("branch", "-D", branch),
            ):
                try:
                    _git(repo, *args)
                except Exception:  # noqa: BLE001 - best-effort cleanup
                    pass
            shutil.rmtree(scratch, ignore_errors=True)

    return measure


def _git(cwd: Path | str, *args: str) -> None:
    proc = subprocess.run(
        ["git", "-C", str(cwd), *args], capture_output=True, text=True, timeout=120
    )
    if proc.returncode != 0:
        raise RuntimeError(f"git {args[0]} failed: {proc.stderr[-1000:]}")


def _parse_marker(stdout: str) -> float:
    for line in reversed(stdout.splitlines()):
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            data = json.loads(line)
        except json.JSONDecodeError:
            continue
        timing = data.get(_MARKER)
        if isinstance(timing, dict):
            return float(timing["seconds"])
    raise RuntimeError(
        "bench verification produced no timing marker in guest stdout: "
        + stdout[-500:]
    )
