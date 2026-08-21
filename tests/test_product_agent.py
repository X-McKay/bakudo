from __future__ import annotations

import ast
import hashlib
import json
import os
import shutil
import signal
import subprocess
from pathlib import Path

import pytest

from bakudo.abox.runner import AboxError, AboxOutcome
from bakudo.cli import main as cli_main
from bakudo.product_agent import ProductAgentInputError, run_product_agent
from bakudo.product_agent.staging import _validate_relative_path, validate_input

REPO = Path(__file__).resolve().parents[1]
FORBIDDEN_ENV = {
    "BAKUDO_ABOX_SKIP_VERSION_CHECK",
    "BAKUDO_ALLOW_NETWORK_OPEN",
    "BAKUDO_BASE_REF",
    "BAKUDO_ENV",
    "BAKUDO_OFFLINE",
    "BAKUDO_REPO_ROOT",
    "BAKUDO_SANDBOX",
}


def _git(path: Path, *args: str) -> str:
    process = subprocess.run(
        ["git", *args],
        cwd=path,
        capture_output=True,
        text=True,
        check=True,
    )
    return process.stdout.strip()


def _workspace(root: Path) -> Path:
    workspace = root / "workspace"
    (workspace / ".abox").mkdir(parents=True)
    (workspace / "src" / "bakudo").mkdir(parents=True)
    shutil.copy2(REPO / ".abox" / "project.toml", workspace / ".abox" / "project.toml")
    shutil.copy2(REPO / ".abox" / "prepare.sh", workspace / ".abox" / "prepare.sh")
    (workspace / "pyproject.toml").write_text('[project]\nname = "bakudo"\n')
    (workspace / "src" / "bakudo" / "__init__.py").write_text('__version__ = "test"\n')
    _git(workspace, "init", "-q", "-b", "main")
    _git(workspace, "config", "user.email", "product-agent@test")
    _git(workspace, "config", "user.name", "product-agent-test")
    _git(workspace, "config", "commit.gpgsign", "false")
    _git(workspace, "add", "-A")
    _git(workspace, "commit", "-q", "-m", "fixture")
    return workspace


@pytest.fixture(autouse=True)
def _clean_product_environment(monkeypatch):
    for name in list(os.environ):
        if name in FORBIDDEN_ENV or name.startswith("ABOX_"):
            monkeypatch.delenv(name, raising=False)


class FakeRunner:
    def __init__(
        self,
        patch: bytes = b"diff --git a/x b/x\n",
        *,
        status: str = "success",
        changed_files: list[str] | None = None,
        version: str = "0.7.2",
    ) -> None:
        self.patch = patch
        self.status = status
        self.changed_files = changed_files or ["src/example.py"]
        self.version = version
        self.bundle = None
        self.cancel_event = None

    def verify_binary(self) -> str:
        return self.version

    def run(self, bundle, cancel_event=None) -> AboxOutcome:
        self.bundle = bundle
        self.cancel_event = cancel_event
        return AboxOutcome(
            run_id=bundle.run_id,
            abox_task_id=bundle.run_id,
            exit_code=0 if self.status != "failed" else 1,
            git_branch=f"agent/{bundle.run_id}",
            result={
                "run_id": bundle.run_id,
                "agent": bundle.agent_spec.ref,
                "objective_id": bundle.objective_id,
                "status": self.status,
                "summary": "must not cross the public boundary",
            },
            diff=self.patch.decode("utf-8", errors="replace"),
            patch_bytes=self.patch,
            changed_files=list(self.changed_files),
            runtime_seconds=1.25,
            tokens_used=11,
            observability={"model_calls": 2, "tool_calls": 3},
            denied_commands=[{"command": "", "reason": "policy"}],
        )


def _invoke(tmp_path: Path, runner: FakeRunner):
    workspace = _workspace(tmp_path)
    instruction = tmp_path / "instruction.md"
    instruction.write_text("Make the smallest correct change.\n")
    output = tmp_path / "output"
    result = run_product_agent(
        protocol="v1",
        workspace=workspace,
        instruction_file=instruction,
        output_dir=output,
        runner_factory=lambda _workspace_path: runner,
    )
    return workspace, output, result


def test_product_agent_emits_atomic_no_score_contract(tmp_path):
    patch = b"diff --git a/src/example.py b/src/example.py\n"
    runner = FakeRunner(patch)
    workspace, output, result = _invoke(tmp_path, runner)

    assert sorted(path.name for path in output.iterdir()) == ["candidate.patch", "result.json"]
    assert (output / "candidate.patch").read_bytes() == patch
    document = json.loads((output / "result.json").read_text())
    assert document == result.to_dict()
    assert document["status"] == "completed"
    assert document["reason_code"] is None
    assert document["patch"]["digest"] == "sha256:" + hashlib.sha256(patch).hexdigest()
    assert document["usage"] == {
        "wall_time_ms": 1250,
        "tokens": 11,
        "model_calls": 2,
        "tool_calls": 3,
        "denied_commands": 1,
    }
    assert document["runtime"]["abox_version"] == "0.7.2"
    assert document["runtime"]["attested"] is False
    assert set(document).isdisjoint({"score", "reward", "passed", "verdict", "scorecard"})
    assert "summary" not in json.dumps(document)
    assert runner.bundle.agent_spec.sandbox.base_ref == _git(workspace, "rev-parse", "HEAD")
    assert runner.bundle.objective.description == "Make the smallest correct change.\n"


def test_product_agent_publication_is_one_atomic_directory_replace(tmp_path, monkeypatch):
    from bakudo.product_agent import staging

    real_replace = os.replace
    observed = {}

    def inspect_replace(source, destination):
        observed["files"] = sorted(path.name for path in Path(source).iterdir())
        observed["destination_absent"] = not Path(destination).exists()
        real_replace(source, destination)

    monkeypatch.setattr(staging.os, "replace", inspect_replace)
    _workspace_path, output, _result = _invoke(tmp_path, FakeRunner())

    assert observed == {
        "files": ["candidate.patch", "result.json"],
        "destination_absent": True,
    }
    assert output.is_dir()


def test_sandbox_launch_failure_publishes_no_detail_and_empty_patch(tmp_path):
    class BrokenRunner(FakeRunner):
        def run(self, bundle, cancel_event=None):
            raise AboxError("secret host detail")

    _workspace_path, output, result = _invoke(tmp_path, BrokenRunner())
    assert result.status.value == "failed"
    assert result.reason_code.value == "sandbox_unavailable"
    assert (output / "candidate.patch").read_bytes() == b""
    assert "secret host detail" not in (output / "result.json").read_text()


@pytest.mark.parametrize(
    ("exit_code", "timed_out", "status", "reason"),
    [(124, True, "timed_out", "sandbox_timeout"), (130, False, "cancelled", "cancelled")],
)
def test_timeout_and_cancellation_are_typed_empty_patch_terminals(
    tmp_path, exit_code, timed_out, status, reason
):
    class TerminalRunner(FakeRunner):
        def run(self, bundle, cancel_event=None):
            return AboxOutcome(
                run_id=bundle.run_id,
                abox_task_id=bundle.run_id,
                exit_code=exit_code,
                git_branch=f"agent/{bundle.run_id}",
                result=None,
                patch_bytes=b"partial",
                changed_files=["partial.py"],
                timed_out=timed_out,
            )

    _workspace_path, output, result = _invoke(tmp_path, TerminalRunner())
    assert result.status.value == status
    assert result.reason_code.value == reason
    assert (output / "candidate.patch").read_bytes() == b""


@pytest.mark.parametrize(
    ("status", "reason"),
    [("blocked", "agent_blocked"), ("failed", "agent_failed")],
)
def test_non_completed_result_never_exports_partial_patch(tmp_path, status, reason):
    _workspace_path, output, result = _invoke(tmp_path, FakeRunner(b"partial", status=status))
    assert result.status.value == status
    assert result.reason_code.value == reason
    assert (output / "candidate.patch").read_bytes() == b""
    assert result.patch.changed_files == ()


def test_reserved_runtime_change_fails_closed(tmp_path):
    runner = FakeRunner(b"malicious", changed_files=[".abox/prepare.sh"])
    _workspace_path, output, result = _invoke(tmp_path, runner)
    assert result.status.value == "failed"
    assert result.reason_code.value == "output_policy_violation"
    assert (output / "candidate.patch").read_bytes() == b""


@pytest.mark.parametrize("version", ["0.8.0", "0.7.2-rc1"])
def test_exact_abox_version_is_required(tmp_path, version):
    workspace = _workspace(tmp_path)
    instruction = tmp_path / "instruction.md"
    instruction.write_text("change it")
    output = tmp_path / "output"
    with pytest.raises(ProductAgentInputError, match="exact abox version 0.7.2"):
        run_product_agent(
            protocol="v1",
            workspace=workspace,
            instruction_file=instruction,
            output_dir=output,
            runner_factory=lambda _path: FakeRunner(version=version),
        )
    assert not output.exists()


@pytest.mark.parametrize(
    "name",
    ["ABOX_CONFIG", "BAKUDO_ABOX_SKIP_VERSION_CHECK", "BAKUDO_BASE_REF"],
)
def test_behavior_changing_ambient_configuration_is_rejected(tmp_path, monkeypatch, name):
    workspace = _workspace(tmp_path)
    instruction = tmp_path / "instruction.md"
    instruction.write_text("change it")
    monkeypatch.setenv(name, "/tmp/host-controlled.toml")
    with pytest.raises(ProductAgentInputError, match=name):
        run_product_agent(
            protocol="v1",
            workspace=workspace,
            instruction_file=instruction,
            output_dir=tmp_path / "output",
            runner_factory=lambda _path: FakeRunner(),
        )


def test_self_host_compatibility_template_mismatch_is_rejected(tmp_path):
    workspace = _workspace(tmp_path)
    (workspace / ".abox" / "project.toml").write_text("[project]\nid='candidate-change'\n")
    _git(workspace, "add", ".abox/project.toml")
    _git(workspace, "commit", "-q", "-m", "change template")
    instruction = tmp_path / "instruction.md"
    instruction.write_text("change it")
    with pytest.raises(ProductAgentInputError, match="compatibility template"):
        validate_input(workspace, instruction, tmp_path / "output")


def test_instruction_symlink_and_overlapping_output_are_rejected(tmp_path):
    workspace = _workspace(tmp_path)
    real_instruction = tmp_path / "instruction.md"
    real_instruction.write_text("change it")
    linked = tmp_path / "linked.md"
    linked.symlink_to(real_instruction)
    with pytest.raises(ProductAgentInputError, match="symbolic link"):
        validate_input(workspace, linked, tmp_path / "output")
    with pytest.raises(ProductAgentInputError, match="must not overlap"):
        validate_input(workspace, real_instruction, workspace / "output")


def test_empty_instruction_and_non_utf8_host_path_are_rejected(tmp_path):
    workspace = _workspace(tmp_path)
    instruction = tmp_path / "instruction.md"
    instruction.write_text(" \n")
    with pytest.raises(ProductAgentInputError, match="must not be empty"):
        validate_input(workspace, instruction, tmp_path / "output")

    instruction.write_text("change it")
    with pytest.raises(ProductAgentInputError, match="valid UTF-8 path"):
        validate_input(workspace, instruction, tmp_path / "bad-\udcff")


def test_tracked_symlink_and_non_utf8_path_are_rejected(tmp_path):
    workspace = _workspace(tmp_path)
    linked = workspace / "tracked-link"
    linked.symlink_to("pyproject.toml")
    _git(workspace, "add", "tracked-link")
    _git(workspace, "commit", "-q", "-m", "add symlink")
    instruction = tmp_path / "instruction.md"
    instruction.write_text("change it")
    with pytest.raises(ProductAgentInputError, match="unsupported tracked entry"):
        validate_input(workspace, instruction, tmp_path / "output")
    with pytest.raises(ProductAgentInputError, match="valid UTF-8"):
        _validate_relative_path("bad-\udcff")


def test_untracked_special_file_is_rejected_even_when_git_status_ignores_it(tmp_path):
    if not hasattr(os, "mkfifo"):  # pragma: no cover - Windows without mkfifo
        pytest.skip("FIFO creation is unavailable")
    workspace = _workspace(tmp_path)
    os.mkfifo(workspace / "invisible-fifo")
    instruction = tmp_path / "instruction.md"
    instruction.write_text("change it")

    with pytest.raises(ProductAgentInputError, match="unsupported special file"):
        validate_input(workspace, instruction, tmp_path / "output")


def test_cli_signal_handler_sets_runner_cancellation_event(tmp_path, monkeypatch):
    observed = {}

    def fake_run_product_agent(**kwargs):
        os.kill(os.getpid(), signal.SIGTERM)
        observed["cancelled"] = kwargs["cancel_event"].is_set()

    monkeypatch.setattr("bakudo.product_agent.run_product_agent", fake_run_product_agent)
    assert (
        cli_main(
            [
                "product-agent",
                "run",
                "--protocol",
                "v1",
                "--workspace",
                str(tmp_path / "workspace"),
                "--instruction-file",
                str(tmp_path / "instruction"),
                "--output-dir",
                str(tmp_path / "output"),
            ]
        )
        == 0
    )
    assert observed == {"cancelled": True}


def test_product_service_has_no_evaluation_imports():
    source = (REPO / "src" / "bakudo" / "product_agent" / "service.py").read_text()
    imported: set[str] = set()
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Import):
            imported.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            imported.add(node.module or "")
    forbidden = (
        "evals",
        "abox.local",
        "control.pipeline",
        "temporal",
        "bakudo.evals",
        "bakudo.abox.local",
        "bakudo.control.pipeline",
        "bakudo.temporal",
    )
    assert not any(
        name == prefix or name.startswith(prefix + ".") for name in imported for prefix in forbidden
    )
