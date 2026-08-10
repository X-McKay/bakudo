"""Issue #28: the fresh-sandbox independent bench measurer.

The winner diff is applied HOST-side onto a temporary verification branch
(abox's in-guest proxy denies mutating git ops like `git apply` — verified
live), then two sandboxes time the bench command, one per ref.
"""

from __future__ import annotations

import json
import subprocess

import pytest

from bakudo.abox.bench import abox_bench_measure
from bakudo.abox.runner import ExecResult


def _repo(tmp_path):
    def git(*args):
        subprocess.run(["git", *args], check=True, cwd=tmp_path, capture_output=True)

    git("init", "-q", "-b", "main")
    git("config", "user.email", "t@t")
    git("config", "user.name", "t")
    git("config", "commit.gpgsign", "false")
    (tmp_path / "x.py").write_text("SLOW = True\n")
    git("add", "-A")
    git("commit", "-q", "-m", "init")
    return tmp_path


DIFF = """\
diff --git a/x.py b/x.py
--- a/x.py
+++ b/x.py
@@ -1 +1 @@
-SLOW = True
+SLOW = False
"""


def _ok_executor(log, seconds=(2.0, 0.5)):
    """Records argv; answers each `abox run` with the next timing marker."""
    remaining = list(seconds)

    def executor(argv, timeout=None):
        log.append((argv, timeout))
        if argv[1] == "run":
            return ExecResult(
                0,
                stdout="noise\n"
                + json.dumps({"verify_bench": {"seconds": remaining.pop(0)}})
                + "\n",
            )
        return ExecResult(0)

    return executor


def test_measure_times_base_and_patched_refs(tmp_path):
    repo = _repo(tmp_path)
    log = []
    measure = abox_bench_measure(
        repo, base_ref="main", timeout=300, executor=_ok_executor(log)
    )
    before, after = measure(DIFF, "python3 bench.py")
    assert (before, after) == (2.0, 0.5)

    runs = [argv for argv, _ in log if argv[1] == "run"]
    assert len(runs) == 2
    first, second = (" ".join(argv) for argv in runs)
    assert "--base main" in first
    assert "--base verify/" in second
    for joined in (first, second):
        assert "--network safe" in joined  # model-authored code: no egress
        assert f"--repo {repo}" in joined
    # The guest command is a python timer, never the raw bench on the host.
    assert "python3" in runs[0][runs[0].index("--") + 1]


def test_measure_cleans_up_sandboxes_branch_and_worktree(tmp_path):
    repo = _repo(tmp_path)
    log = []
    measure = abox_bench_measure(repo, executor=_ok_executor(log))
    measure(DIFF, "python3 bench.py")
    stops = [argv for argv, _ in log if argv[1] == "stop"]
    assert len(stops) == 2 and all("--clean" in argv for argv in stops)
    branches = subprocess.run(
        ["git", "-C", str(repo), "branch"], capture_output=True, text=True
    ).stdout
    assert "verify/" not in branches
    worktrees = subprocess.run(
        ["git", "-C", str(repo), "worktree", "list"], capture_output=True, text=True
    ).stdout
    assert len(worktrees.strip().splitlines()) == 1  # only the main checkout


def test_measure_raises_on_sandbox_failure(tmp_path):
    repo = _repo(tmp_path)

    def failing(argv, timeout=None):
        if argv[1] == "run":
            return ExecResult(1, stdout="bench command failed with exit 2", stderr="")
        return ExecResult(0)

    measure = abox_bench_measure(repo, executor=failing)
    with pytest.raises(RuntimeError, match="bench command failed"):
        measure(DIFF, "python3 bench.py")


def test_measure_raises_when_marker_missing(tmp_path):
    repo = _repo(tmp_path)

    def markerless(argv, timeout=None):
        return ExecResult(0, stdout="bench ran but printed nothing structured")

    measure = abox_bench_measure(repo, executor=markerless)
    with pytest.raises(RuntimeError, match="marker"):
        measure(DIFF, "python3 bench.py")


def test_unappliable_diff_is_a_clean_failure(tmp_path):
    repo = _repo(tmp_path)
    measure = abox_bench_measure(repo, executor=_ok_executor([]))
    with pytest.raises(RuntimeError, match="git apply failed"):
        measure("garbage that is not a diff\n", "python3 bench.py")
    branches = subprocess.run(
        ["git", "-C", str(repo), "branch"], capture_output=True, text=True
    ).stdout
    assert "verify/" not in branches


def test_empty_diff_is_refused(tmp_path):
    """No diff means nothing to verify — refusing is safer than 'verifying'
    an unchanged tree and blessing the claim."""
    measure = abox_bench_measure(_repo(tmp_path), executor=_ok_executor([]))
    with pytest.raises(ValueError, match="empty diff"):
        measure("", "python3 bench.py")


def test_timer_script_compiles_and_takes_best_of_n():
    """The rendered in-guest timer must be valid python (a SyntaxError only
    surfaces live otherwise) and time the bench best-of-N — single-shot
    wall-clock nearly false-failed a micro-bench near the 5% threshold."""
    from bakudo.abox.bench import _BENCH_REPEATS, _MARKER, _TIMER_TEMPLATE

    script = _TIMER_TEMPLATE.format(
        bench="python3 bench.py", marker=_MARKER, repeats=_BENCH_REPEATS
    )
    compile(script, "timer", "exec")
    assert _BENCH_REPEATS >= 3
    assert f"range({_BENCH_REPEATS})" in script
    assert "min(timings)" in script
