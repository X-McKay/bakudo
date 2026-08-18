"""Pin the real abox 0.7.2 CLI protocol (review findings ABOX-1/2/3/5/8/11/12).

Verified against ``abox 0.7.2`` (`abox run --help`, MicroSandbox runtime):

- staging goes through ``--input-file <host>[:<guestname>]`` which lands in
  ``/abox-meta/inputs/`` (read-only) inside the guest — no ``--mount``;
- there is no ``--branch``; the branch is derived from ``--task`` as
  ``agent/<task>``;
- ``--template``/``--snapshot`` do not exist (0.7.0 deleted VM snapshots and
  templates), and bakudo policy profiles were never abox flags;
- run sandboxes boot fresh OCI-image guests: ``abox env warm`` persists only
  declared caches, so the guest command runs the repo's ``.abox/prepare.sh``
  before the runner (verified live: without it the runner module is absent);
- results are collected host-side from the worktree ``abox path <task>``
  resolves, where the guest wrote ``/workspace/.agent/result.json``;
- ``--network`` takes ``safe|scoped|open`` (spec ``none`` maps to ``safe``);
- ``--timeout N`` kills the sandbox with exit code 124.
"""

import json
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

import pytest

from bakudo.abox.runner import (
    AboxNotFoundError,
    AboxRunner,
    ExecResult,
    _subprocess_executor,
)
from bakudo.agent_run_bundle import AgentRunBundle, budget_from_spec
from bakudo.agent_spec import load_spec_file
from bakudo.curriculum import Objective

AGENTS = Path(__file__).resolve().parents[1] / "agents"

VALID_RESULT = {
    "run_id": "run_TEST01",
    "agent": "explore@1",
    "objective_id": "obj_X",
    "status": "success",
    "summary": "mapped",
    "changed_files": ["notes.md"],
}


def _bundle(spec_name: str = "explore.yaml", **spec_overrides):
    spec = load_spec_file(AGENTS / spec_name)
    for key, value in spec_overrides.items():
        object.__setattr__(spec.sandbox, key, value)
    objective = Objective(type="explore", repo="bakudo", title="map it")
    return AgentRunBundle(
        run_id="run_TEST01",
        objective_id=objective.id,
        objective=objective,
        agent_spec=spec,
        budget=budget_from_spec(spec),
    )


def _clear_model_env(monkeypatch):
    import os

    for key in list(os.environ):
        if key in ("BAKUDO_OFFLINE", "VLLM_BASE_URL", "VLLM_API_KEY") or key.startswith(
            "BAKUDO_VLLM_"
        ):
            monkeypatch.delenv(key, raising=False)


def _git(path: Path, *args: str) -> None:
    subprocess.run(["git", *args], check=True, cwd=path, capture_output=True, text=True)


def _make_worktree(path: Path, base: str = "main") -> Path:
    """A stand-in for the worktree abox creates: branch agent/<task> off base."""
    path.mkdir(parents=True, exist_ok=True)
    _git(path, "init", "-q", "-b", base)
    _git(path, "config", "user.email", "t@t")
    _git(path, "config", "user.name", "t")
    _git(path, "config", "commit.gpgsign", "false")
    (path / "tracked.py").write_text("original\n")
    _git(path, "add", "-A")
    _git(path, "commit", "-q", "-m", "base")
    _git(path, "checkout", "-q", "-b", "agent/run_TEST01")
    return path


@dataclass
class FakeAbox:
    """Fake executor speaking the abox 0.7.2 argv surface the runner uses."""

    worktree: Path
    run_exit: int = 0
    run_timed_out: bool = False
    result_doc: dict | None = None
    write_result: bool = True
    calls: list = field(default_factory=list)

    def __call__(self, argv: list[str], timeout: float | None = None) -> ExecResult:
        self.calls.append((list(argv), timeout))
        sub = argv[1]
        if sub == "run":
            if "--input-file" in argv:
                staged = argv[argv.index("--input-file") + 1].rsplit(":", 1)[0]
                self.staged_bundle = json.loads(Path(staged).read_text())
            if self.write_result:
                result_dir = self.worktree / ".agent"
                result_dir.mkdir(parents=True, exist_ok=True)
                doc = self.result_doc if self.result_doc is not None else VALID_RESULT
                (result_dir / "result.json").write_text(json.dumps(doc))
            return ExecResult(
                self.run_exit,
                "boot ok\nagent done\n",
                "some stderr\n",
                timed_out=self.run_timed_out,
            )
        if sub == "path":
            return ExecResult(0, f"{self.worktree}\n", "")
        if sub == "stop":
            return ExecResult(0, "stopped\n", "")
        raise AssertionError(f"unexpected abox subcommand: {argv}")

    def subcommands(self) -> list[str]:
        return [argv[1] for argv, _ in self.calls]


# ---------------------------------------------------------------------------
# build_command: the exact 0.7.0 argv (ABOX-1/2/3/5)
# ---------------------------------------------------------------------------


def test_build_command_matches_abox_0_7_contract(tmp_path, monkeypatch):
    _clear_model_env(monkeypatch)
    monkeypatch.setenv("BAKUDO_OFFLINE", "1")
    monkeypatch.setenv("VLLM_BASE_URL", "https://llm.example/v1")
    monkeypatch.setenv("VLLM_API_KEY", "sk-test")
    monkeypatch.setenv("BAKUDO_VLLM_QWEN_CODER", "https://llm-fast.example/v1")

    runner = AboxRunner(repo_root=tmp_path)
    bundle = _bundle()  # explore: base main, timeout 1800, ephemeral, network none
    cmd = runner.build_command(bundle, tmp_path / "scratch")

    assert cmd == [
        "abox",
        "run",
        "--repo",
        str(tmp_path),
        "--task",
        "run_TEST01",
        "--base",
        "main",
        # spec timeoutSeconds 1800 + IN_GUEST_SETUP_HEADROOM_SECONDS (the
        # in-guest prepare now spends guest deadline before agent work starts).
        "--timeout",
        "2100",
        "--network",
        "scoped",
        "--input-file",
        f"{tmp_path / 'scratch' / 'bundle.json'}:bundle.json",
        "-e",
        "BAKUDO_OFFLINE=1",
        "-e",
        "VLLM_BASE_URL=https://llm.example/v1",
        "-e",
        "VLLM_API_KEY=sk-test",
        "-e",
        "BAKUDO_VLLM_QWEN_CODER=https://llm-fast.example/v1",
        "--",
        # 0.7.0 guests boot fresh from OCI images, so the repo prepare flow
        # (fast against the warm pip cache) must run in-guest before the
        # runner; `python3 -m` stays PATH-proof for the runner itself.
        "sh",
        "-c",
        "set -e; "
        "[ ! -f /workspace/.abox/prepare.sh ] || sh /workspace/.abox/prepare.sh; "
        "exec python3 -m bakudo.runner.main "
        "--bundle /abox-meta/inputs/bundle.json "
        "--result /workspace/.agent/result.json",
    ]


def test_build_command_never_emits_removed_flags(tmp_path, monkeypatch):
    _clear_model_env(monkeypatch)
    cmd = AboxRunner(repo_root=tmp_path).build_command(_bundle(), tmp_path / "s")
    for gone in ("--branch", "--mount", "--template"):
        assert gone not in cmd


def test_build_command_forwards_only_env_present_in_worker(tmp_path, monkeypatch):
    _clear_model_env(monkeypatch)
    monkeypatch.setenv("VLLM_BASE_URL", "https://llm.example/v1")
    cmd = AboxRunner(repo_root=tmp_path).build_command(_bundle(), tmp_path / "s")
    env_args = [cmd[i + 1] for i, a in enumerate(cmd) if a == "-e"]
    assert env_args == ["VLLM_BASE_URL=https://llm.example/v1"]


def test_build_command_never_passes_ephemeral(tmp_path, monkeypatch):
    # abox --ephemeral removes the worktree+branch the moment the agent
    # command exits — *before* the host can collect result.json via
    # `abox path`. Spec ephemerality is instead honoured by the runner's
    # unconditional post-collection `abox stop --clean`.
    _clear_model_env(monkeypatch)
    for bundle in (_bundle(ephemeral=True), _bundle(ephemeral=False)):
        cmd = AboxRunner(repo_root=tmp_path).build_command(bundle, tmp_path / "s")
        assert "--ephemeral" not in cmd


@pytest.mark.parametrize(
    ("spec_mode", "abox_mode"),
    [("none", "safe"), ("scoped", "scoped")],
)
def test_network_mode_maps_to_abox_vocabulary(tmp_path, monkeypatch, spec_mode, abox_mode):
    # ABOX-6: spec says none|scoped|open; abox 0.7.2 says safe|scoped|open.
    _clear_model_env(monkeypatch)
    from bakudo.agent_spec.models import NetworkMode

    bundle = _bundle(network_mode=NetworkMode(spec_mode))
    cmd = AboxRunner(repo_root=tmp_path).build_command(bundle, tmp_path / "s")
    assert cmd[cmd.index("--network") + 1] == abox_mode


def test_network_mode_open_fails_closed_without_operator_opt_in(tmp_path, monkeypatch):
    # The run-level --network replaces the repo's trusted scoped allowlist, so
    # a (possibly model-authored) spec asking for `open` must not silently get
    # public-internet egress.
    _clear_model_env(monkeypatch)
    from bakudo.abox.runner import AboxError
    from bakudo.agent_spec.models import NetworkMode

    bundle = _bundle(network_mode=NetworkMode("open"))
    monkeypatch.delenv("BAKUDO_ALLOW_NETWORK_OPEN", raising=False)
    with pytest.raises(AboxError, match="BAKUDO_ALLOW_NETWORK_OPEN"):
        AboxRunner(repo_root=tmp_path).build_command(bundle, tmp_path / "s")

    monkeypatch.setenv("BAKUDO_ALLOW_NETWORK_OPEN", "1")
    cmd = AboxRunner(repo_root=tmp_path).build_command(bundle, tmp_path / "s")
    assert cmd[cmd.index("--network") + 1] == "open"


# ---------------------------------------------------------------------------
# repo routing (ABOX-7)
# ---------------------------------------------------------------------------


def test_repo_resolves_bare_name_under_repo_root(tmp_path):
    repo = tmp_path / "bakudo"
    _make_worktree(repo)  # any git repo will do
    runner = AboxRunner(repo_root=tmp_path)
    assert runner.resolve_repo(_bundle()) == repo


def test_repo_falls_back_to_repo_root_itself(tmp_path):
    # repo_root has no <name>/ checkout: treat repo_root as the repo.
    runner = AboxRunner(repo_root=tmp_path)
    assert runner.resolve_repo(_bundle()) == tmp_path


def test_repo_root_defaults_to_env_then_cwd(tmp_path, monkeypatch):
    monkeypatch.setenv("BAKUDO_REPO_ROOT", str(tmp_path))
    assert AboxRunner().resolve_repo(_bundle()) == tmp_path
    monkeypatch.delenv("BAKUDO_REPO_ROOT")
    assert AboxRunner().resolve_repo(_bundle()) == Path.cwd()


# --- registry-first resolution (repo onboarding, P2 Task 1) ---------------


@pytest.fixture(autouse=True)
def _reset_repo_resolver():
    """`set_repo_resolver` installs process-wide (module-level) state; reset
    it after every test in this file so a resolver set by one test can never
    leak into another test's resolve_repo() call."""
    from bakudo.abox.runner import set_repo_resolver

    yield
    set_repo_resolver(None)


def test_resolve_repo_uses_registry_lookup_when_present(tmp_path):
    from bakudo.abox.runner import set_repo_resolver

    registered = tmp_path / "elsewhere"
    registered.mkdir()
    set_repo_resolver(lambda name: str(registered) if name == "bakudo" else None)

    runner = AboxRunner(repo_root=tmp_path)
    assert runner.resolve_repo(_bundle()) == registered


def test_resolve_repo_falls_back_to_repo_root_when_lookup_returns_none(tmp_path):
    from bakudo.abox.runner import set_repo_resolver

    repo = tmp_path / "bakudo"
    _make_worktree(repo)
    set_repo_resolver(lambda name: None)

    runner = AboxRunner(repo_root=tmp_path)
    assert runner.resolve_repo(_bundle()) == repo


def test_resolve_repo_absolute_objective_bypasses_registry_lookup(tmp_path):
    """Absolute-path objectives keep bypassing both the resolver and
    BAKUDO_REPO_ROOT (existing behavior Temporal trials depend on)."""
    from bakudo.abox.runner import set_repo_resolver

    abs_repo = tmp_path / "abs-repo"
    _make_worktree(abs_repo)
    calls: list[str] = []

    def resolver(name: str) -> str:
        calls.append(name)
        return str(tmp_path / "should-not-be-used")

    set_repo_resolver(resolver)

    bundle = _bundle()
    bundle.objective.repo = str(abs_repo)
    runner = AboxRunner(repo_root=tmp_path)
    assert runner.resolve_repo(bundle) == abs_repo
    assert calls == [], "absolute-path objectives must never reach the registry lookup"


# ---------------------------------------------------------------------------
# run(): staging, collection, lifecycle (ABOX-2/8/10/11)
# ---------------------------------------------------------------------------


def test_run_stages_bundle_and_collects_result_from_worktree(tmp_path, monkeypatch):
    _clear_model_env(monkeypatch)
    fake = FakeAbox(worktree=_make_worktree(tmp_path / "wt"))
    runner = AboxRunner(executor=fake, repo_root=tmp_path, scratch_root=tmp_path / "scratch")
    outcome = runner.run(_bundle())

    # The bundle was staged for --input-file from the host scratch dir
    # (captured while the sandbox was "running"; scratch is cleaned up after).
    assert fake.staged_bundle["run_id"] == "run_TEST01"

    # Result came from <worktree>/.agent/result.json via `abox path`.
    assert outcome.succeeded
    assert outcome.result["status"] == "success"
    assert outcome.changed_files == ["notes.md"]
    assert outcome.git_branch == "agent/run_TEST01"
    assert fake.subcommands() == ["run", "path", "stop"]


def test_run_passes_headroom_timeout_to_executor(tmp_path, monkeypatch):
    _clear_model_env(monkeypatch)
    fake = FakeAbox(worktree=_make_worktree(tmp_path / "wt"))
    AboxRunner(executor=fake, repo_root=tmp_path).run(_bundle())
    _, timeout = fake.calls[0]
    # spec timeout + in-guest setup headroom + host-side kill headroom
    assert timeout == 1800 + 300 + 600


def test_run_always_stops_clean_with_repo(tmp_path, monkeypatch):
    _clear_model_env(monkeypatch)
    fake = FakeAbox(worktree=_make_worktree(tmp_path / "wt"), run_exit=1)
    AboxRunner(executor=fake, repo_root=tmp_path).run(_bundle())
    stop_argv = fake.calls[-1][0]
    assert stop_argv[:3] == ["abox", "stop", "--clean"]
    assert "run_TEST01" in stop_argv
    assert "--repo" in stop_argv


def test_run_stops_clean_even_when_executor_raises(tmp_path, monkeypatch):
    _clear_model_env(monkeypatch)
    calls = []

    def exploding(argv, timeout=None):
        calls.append(list(argv))
        if argv[1] == "run":
            raise RuntimeError("kaboom")
        return ExecResult(0, "", "")

    with pytest.raises(RuntimeError, match="kaboom"):
        AboxRunner(executor=exploding, repo_root=tmp_path).run(_bundle())
    assert any(argv[1] == "stop" and "--clean" in argv for argv in calls)


def test_missing_binary_raises_clear_error(tmp_path, monkeypatch):
    _clear_model_env(monkeypatch)

    def no_binary(argv, timeout=None):
        raise FileNotFoundError(argv[0])

    with pytest.raises(AboxNotFoundError, match="abox binary not found"):
        AboxRunner(executor=no_binary, repo_root=tmp_path).run(_bundle())


def test_timeout_exit_124_is_a_distinguishable_outcome(tmp_path, monkeypatch):
    _clear_model_env(monkeypatch)
    fake = FakeAbox(
        worktree=_make_worktree(tmp_path / "wt"),
        run_exit=124,
        run_timed_out=True,
        write_result=False,
    )
    outcome = AboxRunner(executor=fake, repo_root=tmp_path).run(_bundle())
    assert outcome.timed_out
    assert not outcome.succeeded
    assert outcome.exit_code == 124


def test_run_captures_stdout_stderr_tails(tmp_path, monkeypatch):
    _clear_model_env(monkeypatch)
    fake = FakeAbox(worktree=_make_worktree(tmp_path / "wt"), run_exit=2)
    outcome = AboxRunner(executor=fake, repo_root=tmp_path).run(_bundle())
    assert "agent done" in outcome.stdout
    assert "some stderr" in outcome.stderr


def test_schema_invalid_result_is_rejected(tmp_path, monkeypatch):
    _clear_model_env(monkeypatch)
    fake = FakeAbox(
        worktree=_make_worktree(tmp_path / "wt"),
        result_doc={"status": "success"},  # missing required fields
    )
    outcome = AboxRunner(executor=fake, repo_root=tmp_path).run(_bundle())
    assert outcome.result is None
    assert not outcome.succeeded
    assert "result.schema.json" in outcome.error


def test_subprocess_executor_maps_timeout_to_exit_124():
    result = _subprocess_executor(["sleep", "5"], timeout=0.2)
    assert result.timed_out
    assert result.exit_code == 124


# ---------------------------------------------------------------------------
# diff + observability passthrough (ABOX-9/10)
# ---------------------------------------------------------------------------


def test_run_collects_diff_including_untracked_files(tmp_path, monkeypatch):
    _clear_model_env(monkeypatch)
    wt = _make_worktree(tmp_path / "wt")
    (wt / "tracked.py").write_text("modified\n")
    (wt / "brand_new.py").write_text("created\n")

    fake = FakeAbox(worktree=wt)
    outcome = AboxRunner(executor=fake, repo_root=tmp_path).run(_bundle())
    assert "modified" in outcome.diff
    assert "brand_new.py" in outcome.diff
    assert outcome.runtime_seconds >= 0.0


def test_run_passes_through_observability_metrics(tmp_path, monkeypatch):
    _clear_model_env(monkeypatch)
    doc = dict(VALID_RESULT)
    doc["metrics"] = {
        "tokens_used": 1234,
        "tool_calls": 7,
        "model_calls": 2,
        "runtime_seconds": 9.5,
        "denied_commands": 1,
    }
    doc["blocked_reasons"] = ["denied:command 'curl' not in allowlist"]
    fake = FakeAbox(worktree=_make_worktree(tmp_path / "wt"), result_doc=doc)
    outcome = AboxRunner(executor=fake, repo_root=tmp_path).run(_bundle())
    assert outcome.tokens_used == 1234
    assert outcome.observability["tool_calls"] == 7
    assert outcome.observability["model_calls"] == 2
    assert outcome.denied_commands == [{"command": "", "reason": "command 'curl' not in allowlist"}]


def test_base_ref_env_override(tmp_path, monkeypatch):
    """BAKUDO_BASE_REF lets an operator run sandboxes against an unmerged
    branch (e.g. validating fixes before they reach the spec's baseRef)."""
    monkeypatch.setenv("BAKUDO_BASE_REF", "validate/some-branch")
    cmd = AboxRunner(repo_root=tmp_path).build_command(_bundle(), tmp_path / "s")
    i = cmd.index("--base")
    assert cmd[i + 1] == "validate/some-branch"


def test_base_ref_defaults_to_spec(tmp_path, monkeypatch):
    monkeypatch.delenv("BAKUDO_BASE_REF", raising=False)
    cmd = AboxRunner(repo_root=tmp_path).build_command(_bundle(), tmp_path / "s")
    i = cmd.index("--base")
    assert cmd[i + 1] == "main"


# --- abox binary identity check (SEC-3) ---


def test_verify_binary_accepts_real_abox_version(tmp_path):
    def fake(argv, timeout=None):
        assert argv[1] == "--version"
        return ExecResult(0, "abox 0.7.2\n", "")

    version = AboxRunner(executor=fake, repo_root=tmp_path).verify_binary()
    assert version == "0.7.2"


def test_verify_binary_rejects_a_wrong_binary(tmp_path):
    from bakudo.abox.runner import AboxError

    def not_abox(argv, timeout=None):
        # A different tool that accepts --version but is not abox.
        return ExecResult(0, "GNU coreutils echo\n", "")

    with pytest.raises(AboxError):
        AboxRunner(executor=not_abox, repo_root=tmp_path).verify_binary()


def test_verify_binary_missing_raises_not_found(tmp_path):
    def missing(argv, timeout=None):
        raise FileNotFoundError(argv[0])

    with pytest.raises(AboxNotFoundError):
        AboxRunner(executor=missing, repo_root=tmp_path).verify_binary()


def test_verify_binary_nonzero_exit_is_rejected(tmp_path):
    from bakudo.abox.runner import AboxError

    def broken(argv, timeout=None):
        return ExecResult(2, "", "unknown flag --version")

    with pytest.raises(AboxError):
        AboxRunner(executor=broken, repo_root=tmp_path).verify_binary()


def test_verify_binary_rejects_generic_version_without_abox_identifier(tmp_path):
    """A wrong binary that prints a bare version (e.g. `python3 --version` ->
    'Python 3.11') must be rejected: the probe requires an abox identifier, not
    just any version number (SEC-3, review follow-up)."""
    from bakudo.abox.runner import AboxError

    def python_like(argv, timeout=None):
        return ExecResult(0, "Python 3.11.15\n", "")

    with pytest.raises(AboxError):
        AboxRunner(executor=python_like, repo_root=tmp_path).verify_binary()


# --- cancellable executor actually kills the process (SEC-5) ---


def test_subprocess_executor_kills_process_when_cancel_event_set():
    """With a cancel_event, a set event terminates the running process rather
    than waiting out the timeout — the fix for cancel-during-sandbox not
    actually stopping the agent."""
    import threading
    import time

    from bakudo.abox.runner import _CANCELLED_EXIT_CODE, _subprocess_executor

    cancel = threading.Event()

    # A process that would run for 30s; we cancel it almost immediately.
    def cancel_soon():
        time.sleep(0.3)
        cancel.set()

    threading.Thread(target=cancel_soon, daemon=True).start()
    start = time.monotonic()
    try:
        result = _subprocess_executor(["sleep", "30"], timeout=30, cancel_event=cancel)
    except FileNotFoundError:
        pytest.skip("`sleep` not available")
    elapsed = time.monotonic() - start
    assert result.exit_code == _CANCELLED_EXIT_CODE
    assert result.timed_out is False
    assert elapsed < 10, "the process must be killed on cancel, not run to timeout"
