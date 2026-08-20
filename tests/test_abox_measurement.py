from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from bakudo.abox import measurement as measurement_module
from bakudo.abox.measurement import AboxMeasurementError, AboxWorkloadInvoker
from bakudo.abox.runner import ExecResult
from bakudo.performance.models import (
    FailureReason,
    InvocationPhase,
    RecordStatus,
    WorkloadSpec,
    canonical_digest,
)
from bakudo.performance.pins import EnvironmentPin, FileDigest, RevisionPin, WorkloadPin
from bakudo.performance.readiness import PerformanceRunnerReadinessError
from bakudo.performance.source import LoadedWorkload, WorkloadProvenance

DIGEST = "sha256:" + "a" * 64


def _loaded(tmp_path: Path) -> LoadedWorkload:
    root = tmp_path / "workload"
    root.mkdir()
    script = root / "run.py"
    script.write_text("print('{}')\n")
    spec = WorkloadSpec.model_validate(
        {
            "metadata": {"name": "latency-smoke", "version": "1.0.0"},
            "subject": {"repo": "demo"},
            "command": {"argv": ["python", "run.py"], "env": {"MODE": "smoke"}},
            "environment": {"profile": "python-small"},
            "measurement": {
                "repetitions": 3,
                "timeoutSeconds": 30,
                "metrics": [
                    {
                        "name": "latency_seconds",
                        "unit": "seconds",
                        "direction": "lower",
                        "source": "wall-clock",
                    }
                ],
            },
        }
    )
    pin = WorkloadPin(
        source_uri=root.as_uri(),
        source_kind="directory",
        collection_revision="test",
        name="latency-smoke",
        version="1.0.0",
        manifest_digest=canonical_digest(spec),
        executor_digests=(FileDigest(path="run.py", digest=DIGEST),),
        bundle_digest=DIGEST,
    )
    return LoadedWorkload(
        spec=spec,
        root=root,
        provenance=WorkloadProvenance(
            loaded_from_uri=root.as_uri(),
            source_uri=root.as_uri(),
            source_kind="directory",
            collection_revision="test",
        ),
        pin=pin,
    )


def _revision(tmp_path: Path, *, patch_digest: str | None = None) -> RevisionPin:
    repo = tmp_path / "repo"
    repo.mkdir(exist_ok=True)
    return RevisionPin(
        repository="repo",
        source_uri=repo.as_uri(),
        commit_sha="1" * 40,
        tree_digest=DIGEST,
        base_commit_sha="1" * 40 if patch_digest else None,
        patch_digest=patch_digest,
    )


def _environment() -> EnvironmentPin:
    return EnvironmentPin(
        bakudo_version="3.0.0",
        abox_version="0.7.2",
        image_digest=DIGEST,
        profile="python-small",
        hardware_class="test",
        architecture="arm64",
        cpu_count=2,
        memory_mb=1024,
        os="linux",
        kernel="test",
        dependency_lock_digest=DIGEST,
        environment_digest=DIGEST,
    )


class _Executor:
    def __init__(self, run_result: ExecResult) -> None:
        self.run_result = run_result
        self.calls: list[list[str]] = []

    def __call__(self, argv: list[str], _timeout: float) -> ExecResult:
        self.calls.append(argv)
        if len(argv) > 1 and argv[1] == "run":
            return self.run_result
        return ExecResult(0)


def _marker(*, exit_code: int = 0, timed_out: bool = False) -> str:
    return json.dumps(
        {
            "bakudo_measurement": {
                "elapsed": 0.25,
                "exit_code": exit_code,
                "timed_out": timed_out,
                "metrics": {"latency_seconds": 0.25},
                "stdout": "",
                "stderr": "",
            }
        }
    )


def test_invocation_uses_pinned_input_argv_and_returns_declared_metric(tmp_path: Path) -> None:
    executor = _Executor(ExecResult(0, stdout="console\n" + _marker()))
    invoker = AboxWorkloadInvoker(executor=executor)

    outcome = invoker.invoke(
        _loaded(tmp_path),
        _revision(tmp_path),
        _environment(),
        phase=InvocationPhase.measured,
        ordinal=2,
    )

    assert outcome.status is RecordStatus.completed
    assert outcome.ordinal == 2
    assert outcome.metrics[0].name == "latency_seconds"
    run_argv = next(argv for argv in executor.calls if argv[1] == "run")
    # abox rejects guest names containing "/" ("must be a plain file name"),
    # so every member is staged under a flat unique guest name and the
    # in-guest wrapper reconstructs the workload layout before executing.
    staged = [run_argv[i + 1] for i, arg in enumerate(run_argv) if arg == "--input-file"]
    assert staged and all(":" in entry and "/" not in entry.split(":", 1)[1] for entry in staged)
    payload = json.loads(run_argv[-1])
    assert payload["argv"] == ["python", "/tmp/bakudo-workload/run.py"]
    assert payload["env"] == {"MODE": "smoke"}
    assert payload["workload_root"] == "/tmp/bakudo-workload"
    assert payload["files"] == {"w0-run.py": "run.py"}


def test_invocation_forwards_declared_guest_cpu_and_memory_limits(tmp_path: Path) -> None:
    executor = _Executor(ExecResult(0, stdout=_marker()))
    loaded = _loaded(tmp_path)
    document = loaded.spec.model_dump(by_alias=True, mode="json")
    document["environment"].update({"cpuCount": 2, "memoryMb": 1024})
    constrained = loaded.model_copy(update={"spec": type(loaded.spec).model_validate(document)})

    outcome = AboxWorkloadInvoker(executor=executor).invoke(
        constrained,
        _revision(tmp_path),
        _environment(),
        phase=InvocationPhase.measured,
        ordinal=0,
    )

    assert outcome.status is RecordStatus.completed
    run_argv = next(argv for argv in executor.calls if argv[1] == "run")
    assert run_argv[run_argv.index("--cpus") + 1] == "2"
    assert run_argv[run_argv.index("--memory") + 1] == "1024"


def test_invocation_runs_preflight_before_creating_a_guest(tmp_path: Path) -> None:
    executor = _Executor(ExecResult(0, stdout=_marker()))
    expected = _environment()
    observed: list[tuple[EnvironmentPin, str]] = []

    def preflight(environment: EnvironmentPin, source: str) -> None:
        observed.append((environment, source))
        raise RuntimeError("runner not admitted")

    with pytest.raises(RuntimeError, match="runner not admitted"):
        AboxWorkloadInvoker(executor=executor, preflight=preflight).invoke(
            _loaded(tmp_path),
            _revision(tmp_path),
            expected,
            phase=InvocationPhase.measured,
            ordinal=0,
        )

    assert observed == [(expected, (tmp_path / "workload").as_uri())]
    assert executor.calls == []


def test_default_invocation_fails_closed_before_creating_a_guest(
    tmp_path: Path, monkeypatch
) -> None:
    for name in (
        "BAKUDO_PERFORMANCE_RUNNER",
        "BAKUDO_SANDBOX",
        "BAKUDO_POSTGRES_DSN",
        "BAKUDO_WORKLOAD_SOURCE",
        "BAKUDO_PERFORMANCE_ENVIRONMENT",
    ):
        monkeypatch.delenv(name, raising=False)

    with pytest.raises(PerformanceRunnerReadinessError, match="preflight failed"):
        AboxWorkloadInvoker().invoke(
            _loaded(tmp_path),
            _revision(tmp_path),
            _environment(),
            phase=InvocationPhase.measured,
            ordinal=0,
        )


def test_trusted_preflight_checks_the_configured_abox_binary(monkeypatch) -> None:
    captured: dict[str, object] = {}

    def record(**kwargs: object) -> object:
        captured.update(kwargs)
        return kwargs["environment"]

    monkeypatch.setattr(measurement_module, "require_trusted_performance_runner", record)
    invoker = AboxWorkloadInvoker(abox_bin="/opt/abox/bin/abox")

    assert invoker.requires_trusted_readiness
    assert invoker._preflight is not None
    invoker._preflight(_environment(), "file:///srv/workloads")

    assert captured["abox_bin"] == "/opt/abox/bin/abox"


def test_nested_workload_layouts_are_staged_flat_and_reconstructed(tmp_path: Path) -> None:
    executor = _Executor(ExecResult(0, stdout=_marker()))
    loaded = _loaded(tmp_path)
    nested = loaded.root / "data"
    nested.mkdir()
    (nested / "corpus.txt").write_text("x\n")

    outcome = AboxWorkloadInvoker(executor=executor).invoke(
        loaded,
        _revision(tmp_path),
        _environment(),
        phase=InvocationPhase.measured,
        ordinal=0,
    )

    assert outcome.status is RecordStatus.completed
    run_argv = next(argv for argv in executor.calls if argv[1] == "run")
    staged = [run_argv[i + 1] for i, arg in enumerate(run_argv) if arg == "--input-file"]
    assert all("/" not in entry.split(":", 1)[1] for entry in staged)
    payload = json.loads(run_argv[-1])
    # Sorted by relative path: data/corpus.txt before run.py.
    assert payload["files"] == {
        "w0-corpus.txt": "data/corpus.txt",
        "w1-run.py": "run.py",
    }
    assert payload["argv"] == ["python", "/tmp/bakudo-workload/run.py"]


def test_guest_names_are_sanitized_and_executable_bits_recorded(tmp_path: Path) -> None:
    executor = _Executor(ExecResult(0, stdout=_marker()))
    loaded = _loaded(tmp_path)
    hostile = loaded.root / "we ird:name.txt"
    hostile.write_text("x\n")
    tool = loaded.root / "tool.sh"
    tool.write_text("#!/bin/sh\nexit 0\n")
    tool.chmod(0o755)

    outcome = AboxWorkloadInvoker(executor=executor).invoke(
        loaded,
        _revision(tmp_path),
        _environment(),
        phase=InvocationPhase.measured,
        ordinal=0,
    )

    assert outcome.status is RecordStatus.completed
    run_argv = next(argv for argv in executor.calls if argv[1] == "run")
    staged = [run_argv[i + 1] for i, arg in enumerate(run_argv) if arg == "--input-file"]
    guest_names = [entry.rsplit(":", 1)[1] for entry in staged]
    # abox parses <hostpath>[:<guestname>] and validates guest names, so a
    # member name may not smuggle separators or shell-hostile characters
    # into the argv; the flat names are index-unique, sanitization cannot
    # collide them.
    assert all(re.fullmatch(r"[A-Za-z0-9._-]+", name) for name in guest_names)
    payload = json.loads(run_argv[-1])
    assert payload["files"]["w2-we_ird_name.txt"] == "we ird:name.txt"
    # Only the executable member is chmod-restored by the wrapper.
    assert payload["executables"] == ["w1-tool.sh"]


def test_staged_guest_names_are_bounded(tmp_path: Path) -> None:
    from bakudo.abox.staging import staged_workload_files

    root = tmp_path / "w"
    root.mkdir()
    (root / ("a" * 250 + ".txt")).write_text("x\n")

    staged = staged_workload_files(root)

    # The reconstruction map carries the real path; the flat name only needs
    # uniqueness, so it is truncated well below the 255-byte filename limit.
    assert staged[0].guest_name == "w0-" + "a" * 64
    assert staged[0].relative_path == "a" * 250 + ".txt"


def test_guest_argv_rewrites_only_safe_member_references(tmp_path: Path) -> None:
    loaded = _loaded(tmp_path)
    absolute = str((loaded.root / "run.py").resolve())
    document = loaded.spec.model_dump(by_alias=True, mode="json")
    document["command"]["argv"] = ["python", absolute, "../run.py", "run.py"]
    with_unsafe = loaded.model_copy(update={"spec": type(loaded.spec).model_validate(document)})

    argv = AboxWorkloadInvoker._guest_argv(with_unsafe)

    # Absolute and traversing tokens pass through untouched (a Path join
    # with an absolute right side would otherwise "resolve" them); only the
    # plain member reference is rewritten.
    assert argv == ["python", absolute, "../run.py", "/tmp/bakudo-workload/run.py"]


def test_failure_detail_strips_ansi_and_control_sequences() -> None:
    from bakudo.abox.measurement import _failure_detail

    noisy = "\x1b[2m2026-08-18\x1b[0m \x1b[31mERROR\x1b[0m boom\r\nline2\x07"
    assert _failure_detail(noisy, "") == "2026-08-18 ERROR boom\nline2"


def test_wrapper_reconstructs_the_layout_and_emits_the_marker(tmp_path: Path) -> None:
    """Execute the real in-guest wrapper locally against a nested layout."""
    import os
    import subprocess
    import sys

    from bakudo.abox.measurement import _WRAPPER

    inputs = tmp_path / "inputs"
    inputs.mkdir()
    (inputs / "w0-corpus.txt").write_text("hello\n")
    (inputs / "w1-run.py").write_text(
        "import json, os, pathlib\n"
        "corpus = pathlib.Path(__file__).parent / 'data' / 'corpus.txt'\n"
        "env_ok = os.environ.get('BAKUDO_WORKLOAD_DIR') == str(pathlib.Path(__file__).parent)\n"
        "print(json.dumps({'corpus_bytes': corpus.stat().st_size, 'env_ok': int(env_ok)}))\n"
    )
    # Staged files lose their mode bits; the wrapper must restore +x for
    # members the host recorded as executable.
    (inputs / "w2-tool.sh").write_text("#!/bin/sh\nexit 0\n")
    root = tmp_path / "reconstructed"
    payload = json.dumps(
        {
            "argv": [sys.executable, str(root / "run.py")],
            "cwd": str(tmp_path),
            "env": {},
            "timeout": 30,
            "files": {
                "w0-corpus.txt": "data/corpus.txt",
                "w1-run.py": "run.py",
                "w2-tool.sh": "bin/tool.sh",
            },
            "executables": ["w2-tool.sh"],
            "workload_root": str(root),
        }
    )
    proc = subprocess.run(
        [sys.executable, "-c", _WRAPPER, payload],
        capture_output=True,
        text=True,
        timeout=60,
        env={**os.environ, "ABOX_INPUT_DIR": str(inputs)},
    )
    assert proc.returncode == 0, proc.stderr
    marker = json.loads(proc.stdout.strip().splitlines()[-1])["bakudo_measurement"]
    assert marker["exit_code"] == 0
    assert marker["metrics"]["corpus_bytes"] == 6.0
    # BAKUDO_WORKLOAD_DIR lets workload code locate members without relying
    # on the working directory (which stays the repository worktree).
    assert marker["metrics"]["env_ok"] == 1.0
    assert (root / "data" / "corpus.txt").read_text() == "hello\n"
    assert os.access(root / "bin" / "tool.sh", os.X_OK)
    assert not os.access(root / "run.py", os.X_OK)


def test_wrapper_reports_unrunnable_argv_through_the_marker(tmp_path: Path) -> None:
    """A launch failure (non-executable argv[0]) must produce a typed marker
    with shell semantics (126) and the failing path, never an unmarked crash."""
    import os
    import subprocess
    import sys

    from bakudo.abox.measurement import _WRAPPER

    inputs = tmp_path / "inputs"
    inputs.mkdir()
    (inputs / "w0-run.py").write_text("print('never runs')\n")
    root = tmp_path / "reconstructed"
    payload = json.dumps(
        {
            "argv": [str(root / "run.py")],
            "cwd": str(tmp_path),
            "env": {},
            "timeout": 30,
            "files": {"w0-run.py": "run.py"},
            "executables": [],
            "workload_root": str(root),
        }
    )
    proc = subprocess.run(
        [sys.executable, "-c", _WRAPPER, payload],
        capture_output=True,
        text=True,
        timeout=60,
        env={**os.environ, "ABOX_INPUT_DIR": str(inputs)},
    )
    assert proc.returncode == 0, proc.stderr
    marker = json.loads(proc.stdout.strip().splitlines()[-1])["bakudo_measurement"]
    assert marker["exit_code"] == 126
    assert "failed to launch workload argv" in marker["stderr"]
    assert "run.py" in marker["stderr"]


def test_abox_failure_is_an_explicit_infrastructure_outcome(tmp_path: Path) -> None:
    executor = _Executor(ExecResult(9, stderr="guest failed"))
    outcome = AboxWorkloadInvoker(executor=executor).invoke(
        _loaded(tmp_path),
        _revision(tmp_path),
        _environment(),
        phase=InvocationPhase.warmup,
        ordinal=0,
    )

    assert outcome.status is RecordStatus.failed
    assert outcome.failure_reason is not None
    assert outcome.metrics == ()
    # The abox stderr tail must survive into the outcome: an operator
    # debugging a live infrastructure failure otherwise sees nothing.
    assert outcome.failure_detail is not None
    assert "guest failed" in outcome.failure_detail


def test_workload_failure_preserves_the_marker_stderr_tail(tmp_path: Path) -> None:
    executor = _Executor(
        ExecResult(
            0,
            stdout=json.dumps(
                {
                    "bakudo_measurement": {
                        "elapsed": 0.1,
                        "exit_code": 127,
                        "timed_out": False,
                        "metrics": {},
                        "stdout": "",
                        "stderr": "workload argv[0] not found in guest: python",
                    }
                }
            ),
        )
    )
    outcome = AboxWorkloadInvoker(executor=executor).invoke(
        _loaded(tmp_path),
        _revision(tmp_path),
        _environment(),
        phase=InvocationPhase.measured,
        ordinal=0,
    )

    assert outcome.status is RecordStatus.failed
    assert outcome.exit_code == 127
    assert outcome.failure_detail is not None
    assert "argv[0] not found" in outcome.failure_detail


def test_missing_marker_is_a_diagnosable_outcome_and_still_cleans_up(tmp_path: Path) -> None:
    """abox exited 0 but no trusted marker came back — the most opaque
    failure mode must persist the output tail, not raise into the service's
    deliberately detail-free adapter handler."""
    executor = _Executor(ExecResult(0, stdout="not measurement json"))
    outcome = AboxWorkloadInvoker(executor=executor).invoke(
        _loaded(tmp_path),
        _revision(tmp_path),
        _environment(),
        phase=InvocationPhase.measured,
        ordinal=0,
    )

    assert outcome.status is RecordStatus.failed
    assert outcome.failure_reason is FailureReason.infrastructure
    assert outcome.failure_detail is not None
    assert "no trusted JSON marker" in outcome.failure_detail
    assert "not measurement json" in outcome.failure_detail
    assert any(len(argv) > 1 and argv[1] == "stop" for argv in executor.calls)


def test_candidate_requires_exact_patch_bytes(tmp_path: Path) -> None:
    executor = _Executor(ExecResult(0, stdout=_marker()))
    with pytest.raises(AboxMeasurementError, match="patch bytes unavailable"):
        AboxWorkloadInvoker(executor=executor).invoke(
            _loaded(tmp_path),
            _revision(tmp_path, patch_digest=DIGEST),
            _environment(),
            phase=InvocationPhase.measured,
            ordinal=0,
        )


def test_candidate_patch_bytes_must_match_pinned_digest(tmp_path: Path) -> None:
    executor = _Executor(ExecResult(0, stdout=_marker()))
    with pytest.raises(AboxMeasurementError, match="do not match"):
        AboxWorkloadInvoker(
            executor=executor,
            candidate_patches={DIGEST: "not the pinned patch"},
        ).invoke(
            _loaded(tmp_path),
            _revision(tmp_path, patch_digest=DIGEST),
            _environment(),
            phase=InvocationPhase.measured,
            ordinal=0,
        )
