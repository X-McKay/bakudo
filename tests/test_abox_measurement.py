from __future__ import annotations

import json
from pathlib import Path

import pytest

from bakudo.abox.measurement import AboxMeasurementError, AboxWorkloadInvoker
from bakudo.abox.runner import ExecResult
from bakudo.performance.models import InvocationPhase, RecordStatus, WorkloadSpec, canonical_digest
from bakudo.performance.pins import EnvironmentPin, FileDigest, RevisionPin, WorkloadPin
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
        abox_version="0.7.1",
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
    assert "--input-file" in run_argv
    payload = json.loads(run_argv[-1])
    assert payload["argv"] == ["python", "/abox-meta/inputs/workload/run.py"]
    assert payload["env"] == {"MODE": "smoke"}
    assert isinstance(payload["argv"], list)


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


def test_missing_marker_fails_loudly_and_still_cleans_up(tmp_path: Path) -> None:
    executor = _Executor(ExecResult(0, stdout="not measurement json"))
    with pytest.raises(AboxMeasurementError, match="no trusted JSON marker"):
        AboxWorkloadInvoker(executor=executor).invoke(
            _loaded(tmp_path),
            _revision(tmp_path),
            _environment(),
            phase=InvocationPhase.measured,
            ordinal=0,
        )
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
