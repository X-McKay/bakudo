"""Task 8: the abox-backed verifier-test runner (offline, subprocess mocked).

Mirrors ``tests/test_abox_bench.py``'s mock-executor pattern: a fake
``Executor`` records argv and answers ``abox run``/``abox stop`` calls, so
these tests never touch a real abox binary or KVM.
"""

from __future__ import annotations

import subprocess

import pytest

from bakudo.abox.runner import ExecResult
from bakudo.abox.verifier_bench import AboxVerifierEvalError, make_abox_verifier_runner


def _workspace(tmp_path):
    """A throwaway scratch repo shaped like what trials/verifier.py hands the
    runner: one committed "provisioned fixture" commit, plus an uncommitted
    diff-applied file and an uncommitted, untracked verifier test file."""

    def git(*args):
        subprocess.run(["git", *args], check=True, cwd=tmp_path, capture_output=True)

    git("init", "-q", "-b", "main")
    git("config", "user.email", "t@t")
    git("config", "user.name", "t")
    git("config", "commit.gpgsign", "false")
    (tmp_path / "summer.py").write_text("def sum_column(): ...\n")
    git("add", "-A")
    git("commit", "-q", "-m", "provision: initial fixture state")

    # Simulate the diff having been applied (uncommitted) and the verifier
    # test file having been copied in (untracked) -- both still dirty when
    # trials/verifier.py calls the runner.
    (tmp_path / "summer.py").write_text("def sum_column(): return total\n")
    verifier_dir = tmp_path / "verifier"
    verifier_dir.mkdir()
    (verifier_dir / "test_sum.py").write_text("def test_sum(): assert True\n")
    return tmp_path


def _ok_executor(log, exit_code=0, stdout="collected 1 item\n1 passed\n", stderr=""):
    def executor(argv, timeout=None):
        log.append((argv, timeout))
        if argv[1] == "run":
            return ExecResult(exit_code, stdout=stdout, stderr=stderr)
        return ExecResult(0)

    return executor


@pytest.fixture(autouse=True)
def _abox_sandbox_env(monkeypatch):
    # The runner's own fail-closed guard (defense in depth -- callers already
    # gate on this before ever selecting abox_verifier_runner).
    monkeypatch.setenv("BAKUDO_SANDBOX", "abox")


def test_runner_builds_repo_task_network_and_base_ref(tmp_path):
    ws = _workspace(tmp_path)
    log = []
    runner = make_abox_verifier_runner(executor=_ok_executor(log))

    runner(ws, "pytest verifier/test_sum.py -q")

    runs = [argv for argv, _ in log if argv[1] == "run"]
    assert len(runs) == 1
    argv = runs[0]
    joined = " ".join(argv)
    assert f"--repo {ws}" in joined
    assert "--network safe" in joined  # workspace may hold agent-authored diff content
    assert "--task" in argv
    assert "--base" in argv
    base_ref = argv[argv.index("--base") + 1]
    assert len(base_ref) == 40  # a real commit sha, not a branch name

    # The base ref must actually resolve inside the workspace repo (the
    # runner committed the dirty tree before invoking abox).
    resolved = subprocess.run(
        ["git", "-C", str(ws), "cat-file", "-e", base_ref], capture_output=True
    )
    assert resolved.returncode == 0


def test_runner_commits_dirty_workspace_before_forking(tmp_path):
    """abox forks a worktree from a git ref -- it never sees a dirty working
    tree (same reasoning as bench.py's module docstring). The applied diff
    and copied-in verifier test file must be committed first."""
    ws = _workspace(tmp_path)
    status_before = subprocess.run(
        ["git", "-C", str(ws), "status", "--porcelain"], capture_output=True, text=True
    ).stdout
    assert status_before.strip()  # sanity: workspace really is dirty

    runner = make_abox_verifier_runner(executor=_ok_executor([]))
    runner(ws, "pytest verifier/test_sum.py -q")

    status_after = subprocess.run(
        ["git", "-C", str(ws), "status", "--porcelain"], capture_output=True, text=True
    ).stdout
    assert status_after.strip() == ""

    log_lines = (
        subprocess.run(["git", "-C", str(ws), "log", "--oneline"], capture_output=True, text=True)
        .stdout.strip()
        .splitlines()
    )
    assert len(log_lines) == 2  # provision commit + the runner's snapshot commit


def test_command_rides_as_its_own_argv_element(tmp_path):
    """No shell-quoting hazard: the test command is never interpolated into
    the outer guest script string, only passed as a trailing argv element
    (bench.py's timer-script pattern)."""
    ws = _workspace(tmp_path)
    log = []
    runner = make_abox_verifier_runner(executor=_ok_executor(log))
    command = "pytest 'verifier/test_sum.py' -q"

    runner(ws, command)

    argv = next(a for a, _ in log if a[1] == "run")
    guest_cmd = argv[argv.index("--") + 1 :]
    assert guest_cmd[0] == "sh" and guest_cmd[1] == "-c"
    assert command not in guest_cmd[2]  # not spliced into the script text
    assert guest_cmd[-1] == command  # rides as its own element ($1)
    assert "prepare.sh" in guest_cmd[2]


def test_runner_maps_zero_exit_to_passed(tmp_path):
    ws = _workspace(tmp_path)
    runner = make_abox_verifier_runner(executor=_ok_executor([], exit_code=0, stdout="ok\n"))

    result = runner(ws, "pytest verifier/test_sum.py -q")

    assert result.passed is True
    assert result.exit_code == 0
    assert "ok" in result.output


def test_runner_maps_nonzero_exit_to_failed_with_output_tail(tmp_path):
    ws = _workspace(tmp_path)
    long_output = "x" * 20_000 + "AssertionError: boom"
    runner = make_abox_verifier_runner(
        executor=_ok_executor([], exit_code=1, stdout=long_output, stderr="")
    )

    result = runner(ws, "pytest verifier/test_sum.py -q")

    assert result.passed is False
    assert result.exit_code == 1
    assert "AssertionError: boom" in result.output
    assert len(result.output) < len(long_output)  # tail, not the full blob


def test_runner_maps_timeout_exit_code_to_failed(tmp_path):
    ws = _workspace(tmp_path)
    runner = make_abox_verifier_runner(executor=_ok_executor([], exit_code=124, stdout=""))

    result = runner(ws, "pytest verifier/test_sum.py -q")

    assert result.passed is False
    assert result.exit_code == 124


def test_runner_always_cleans_up_the_sandbox(tmp_path):
    ws = _workspace(tmp_path)
    log = []
    runner = make_abox_verifier_runner(executor=_ok_executor(log))

    runner(ws, "pytest verifier/test_sum.py -q")

    stops = [argv for argv, _ in log if argv[1] == "stop"]
    assert len(stops) == 1
    assert "--clean" in stops[0]
    assert str(ws) in " ".join(stops[0])


def test_runner_cleans_up_even_when_the_run_executor_raises(tmp_path):
    ws = _workspace(tmp_path)
    log = []

    def flaky(argv, timeout=None):
        log.append((argv, timeout))
        if argv[1] == "run":
            raise FileNotFoundError("abox binary vanished mid-run")
        return ExecResult(0)

    runner = make_abox_verifier_runner(executor=flaky)
    with pytest.raises(FileNotFoundError):
        runner(ws, "pytest verifier/test_sum.py -q")

    stops = [argv for argv, _ in log if argv[1] == "stop"]
    assert len(stops) == 1


def test_runner_refuses_when_git_snapshot_fails(tmp_path):
    """A workspace that isn't actually a git repo (or some other host-git
    failure) is a clean, actionable failure -- not a silent abox run against
    nothing."""
    not_a_repo = tmp_path / "not-a-repo"
    not_a_repo.mkdir()
    runner = make_abox_verifier_runner(executor=_ok_executor([]))

    with pytest.raises(AboxVerifierEvalError):
        runner(not_a_repo, "pytest verifier/test_sum.py -q")


def test_runner_fails_closed_without_bakudo_sandbox_abox(tmp_path, monkeypatch):
    monkeypatch.delenv("BAKUDO_SANDBOX", raising=False)
    ws = _workspace(tmp_path)
    runner = make_abox_verifier_runner(executor=_ok_executor([]))

    with pytest.raises(RuntimeError, match="BAKUDO_SANDBOX=abox"):
        runner(ws, "pytest verifier/test_sum.py -q")


def test_runner_fails_closed_when_bakudo_sandbox_is_something_else(tmp_path, monkeypatch):
    monkeypatch.setenv("BAKUDO_SANDBOX", "local")
    ws = _workspace(tmp_path)
    runner = make_abox_verifier_runner(executor=_ok_executor([]))

    with pytest.raises(RuntimeError, match="BAKUDO_SANDBOX=abox"):
        runner(ws, "pytest verifier/test_sum.py -q")


# --------------------------------------------------------------------------
# Synthetic guest environment (task fixtures ship no .abox/ of their own
# -- confirmed live against the real abox binary: the default "base" guest
# profile has no python3 at all)
# --------------------------------------------------------------------------


def test_runner_synthesizes_python_environment_for_a_bare_workspace(tmp_path):
    ws = _workspace(tmp_path)
    runner = make_abox_verifier_runner(executor=_ok_executor([]))

    runner(ws, "pytest verifier/test_sum.py -q")

    project_toml = (ws / ".abox" / "project.toml").read_text()
    assert 'profile = "python-glibc"' in project_toml
    prepare_sh = ws / ".abox" / "prepare.sh"
    assert "pytest" in prepare_sh.read_text()
    assert prepare_sh.stat().st_mode & 0o111  # executable


def test_runner_never_overwrites_an_existing_abox_config(tmp_path):
    ws = _workspace(tmp_path)
    abox_dir = ws / ".abox"
    abox_dir.mkdir()
    custom = "a repo-owned config that must survive untouched\n"
    (abox_dir / "project.toml").write_text(custom)
    runner = make_abox_verifier_runner(executor=_ok_executor([]))

    runner(ws, "pytest verifier/test_sum.py -q")

    assert (abox_dir / "project.toml").read_text() == custom
    assert not (abox_dir / "prepare.sh").exists()


def test_synthetic_environment_content_is_fixed_across_workspaces(tmp_path):
    """The abox approval fingerprint is content-derived; a stable fingerprint
    means a one-time `abox project trust` covers every future ephemeral
    verifier-eval workspace, so the synthesized bytes must never vary."""
    from bakudo.abox.verifier_bench import _ensure_guest_environment

    ws_a = tmp_path / "a"
    ws_b = tmp_path / "b"
    ws_a.mkdir()
    ws_b.mkdir()
    _ensure_guest_environment(ws_a)
    _ensure_guest_environment(ws_b)

    assert (ws_a / ".abox" / "project.toml").read_text() == (
        ws_b / ".abox" / "project.toml"
    ).read_text()
    assert (ws_a / ".abox" / "prepare.sh").read_text() == (
        ws_b / ".abox" / "prepare.sh"
    ).read_text()


def test_default_abox_verifier_runner_instance_is_importable():
    """Production callers (Deps.verifier_eval_fn's ladder, the CLI) import a
    ready-to-use instance, same shape as local_verifier_runner -- no factory
    call required at the call site."""
    from bakudo.abox.verifier_bench import abox_verifier_runner
    from bakudo.tasks.verifier_runner import VerificationResult

    assert callable(abox_verifier_runner)
    # Signature parity with the VerifierRunner protocol; not actually invoked
    # here (would need a real abox binary).
    import inspect

    params = list(inspect.signature(abox_verifier_runner).parameters)
    assert params == ["workspace", "command"]
    assert VerificationResult  # imported for readers checking the protocol shape
