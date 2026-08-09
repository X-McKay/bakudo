"""Issue #28: the fresh-sandbox independent bench measurer."""

from __future__ import annotations

import json

import pytest

from bakudo.abox.bench import abox_bench_measure
from bakudo.abox.runner import ExecResult


def _ok_executor(log):
    """Records argv; answers `abox run` with a verify marker, others with 0."""

    def executor(argv, timeout=None):
        log.append((argv, timeout))
        if argv[1] == "run":
            return ExecResult(
                0,
                stdout="noise\n"
                + json.dumps({"verify_bench": {"before": 2.0, "after": 0.5}})
                + "\n",
            )
        return ExecResult(0)

    return executor


def test_measure_runs_bench_in_fresh_safe_sandbox(tmp_path):
    log = []
    measure = abox_bench_measure(
        tmp_path, base_ref="main", timeout=300, executor=_ok_executor(log)
    )
    before, after = measure("--- a/x.py\n+++ b/x.py\n", "python3 bench.py")
    assert (before, after) == (2.0, 0.5)

    run_argv = next(argv for argv, _ in log if argv[1] == "run")
    joined = " ".join(run_argv)
    assert "--network safe" in joined  # model-authored code: no egress
    assert f"--repo {tmp_path}" in joined
    assert "--base main" in joined
    assert "--input-file" in joined and "verify.patch" in joined
    # The guest command is a python timer, never the raw bench on the host.
    assert "python3" in run_argv[run_argv.index("--") + 1]


def test_measure_always_stops_and_cleans(tmp_path):
    log = []
    measure = abox_bench_measure(tmp_path, executor=_ok_executor(log))
    measure("diff", "python3 bench.py")
    stop_argv = next(argv for argv, _ in log if argv[1] == "stop")
    assert "--clean" in stop_argv


def test_measure_raises_on_sandbox_failure(tmp_path):
    def failing(argv, timeout=None):
        if argv[1] == "run":
            return ExecResult(1, stdout="", stderr="patch does not apply")
        return ExecResult(0)

    measure = abox_bench_measure(tmp_path, executor=failing)
    with pytest.raises(RuntimeError, match="patch does not apply"):
        measure("bad diff", "python3 bench.py")


def test_measure_raises_when_marker_missing(tmp_path):
    def markerless(argv, timeout=None):
        return ExecResult(0, stdout="bench ran but printed nothing structured")

    measure = abox_bench_measure(tmp_path, executor=markerless)
    with pytest.raises(RuntimeError, match="marker"):
        measure("diff", "python3 bench.py")


def test_empty_diff_is_refused(tmp_path):
    """No diff means nothing to verify — refusing is safer than 'verifying'
    an unchanged tree and blessing the claim."""
    measure = abox_bench_measure(tmp_path, executor=_ok_executor([]))
    with pytest.raises(ValueError, match="empty diff"):
        measure("", "python3 bench.py")
