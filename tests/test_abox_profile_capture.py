from __future__ import annotations

import json
import marshal
import subprocess
import sys
import threading
from collections.abc import Sequence
from pathlib import Path

import pytest

from bakudo.abox.capture import (
    AboxProfileCaptureError,
    AboxProfileCaptureService,
    bounded_abox_executor,
    configured_profile_capture_service,
)
from bakudo.abox.profiler import ProfileProcessResult
from bakudo.performance.artifacts import InMemoryArtifactStore
from bakudo.performance.models import (
    EnvironmentPin,
    ProfilerSpec,
    RevisionPin,
    WorkloadSpec,
)
from bakudo.performance.profiler import (
    CaptureLimits,
    ProfileExecutionError,
    ProfileTimeoutError,
)
from bakudo.performance.revisions import pin_repository_revision, sha256_text
from bakudo.performance.source import LoadedWorkload, WorkloadProvenance
from bakudo.performance.verify import verify_and_pin_workload

_DIGEST = "sha256:" + "a" * 64
_SNAPSHOT_ID = "snapshot_" + "0" * 26


def _git(repo: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(repo), *args],
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout.strip()


def _repository(tmp_path: Path) -> tuple[Path, RevisionPin]:
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init", "-q")
    (repo / "hot.py").write_text("def hot():\n    return sum(range(100))\nhot()\n")
    _git(repo, "add", "hot.py")
    _git(
        repo,
        "-c",
        "user.email=test@example.invalid",
        "-c",
        "user.name=Test",
        "commit",
        "-q",
        "-m",
        "fixture",
    )
    revision = pin_repository_revision(repo, repository="demo")
    return repo, revision


def _profiler() -> ProfilerSpec:
    return ProfilerSpec(
        name="python-sampling",
        adapter="python.sampling",
        signals=("function-calls",),
    )


def _loaded(tmp_path: Path) -> LoadedWorkload:
    root = tmp_path / "workload"
    root.mkdir()
    (root / "README.txt").write_text("immutable capture inputs\n")
    spec = WorkloadSpec.model_validate(
        {
            "metadata": {"name": "profile-smoke", "version": "1.0.0"},
            "subject": {"repo": "demo"},
            "command": {
                "argv": ["python", "-m", "hot"],
                "env": {"PYTHONHASHSEED": "0"},
            },
            "environment": {
                "profile": "python-small",
                "cpuCount": 1,
                "memoryMb": 512,
            },
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
            "profilers": [_profiler().model_dump(by_alias=True, mode="json")],
        }
    )
    report = verify_and_pin_workload(
        root,
        spec,
        source_uri=root.as_uri(),
        source_kind="directory",
        collection_revision="test",
    )
    assert report.ok and report.pin is not None
    return LoadedWorkload(
        spec=spec,
        root=root,
        provenance=WorkloadProvenance(
            loaded_from_uri=root.as_uri(),
            source_uri=root.as_uri(),
            source_kind="directory",
            collection_revision="test",
        ),
        pin=report.pin,
    )


def _environment(*, abox_version: str = "0.7.1") -> EnvironmentPin:
    return EnvironmentPin(
        bakudo_version="3.0.0",
        abox_version=abox_version,
        image_digest=_DIGEST,
        profile="python-small",
        hardware_class="test",
        architecture="arm64",
        cpu_count=1,
        memory_mb=512,
        os="linux",
        kernel="test",
        dependency_lock_digest=_DIGEST,
        environment_digest=_DIGEST,
    )


class _FakeAbox:
    def __init__(
        self,
        worktree: Path,
        *,
        run_result: ProfileProcessResult | None = None,
        version: str = "abox 0.7.1",
    ) -> None:
        self.worktree = worktree
        self.run_result = run_result or ProfileProcessResult(0)
        self.version = version
        self.calls: list[tuple[str, ...]] = []
        self.run_payload: dict[str, object] | None = None

    def __call__(
        self,
        argv: Sequence[str],
        *,
        timeout: float,
        max_output_chars: int,
        cancel_event: object | None = None,
    ) -> ProfileProcessResult:
        del timeout, max_output_chars, cancel_event
        command = tuple(argv)
        self.calls.append(command)
        if command[1:] == ("--version",):
            return ProfileProcessResult(0, stdout=self.version)
        if command[1] == "run":
            self.run_payload = json.loads(command[-1])
            if self.run_result.exit_code == 0:
                output = self.worktree / ".bakudo" / "profile.raw"
                output.parent.mkdir(parents=True, exist_ok=True)
                with output.open("wb") as stream:
                    marshal.dump(
                        {("/workspace/hot.py", 1, "hot"): (1, 1, 0.1, 0.2, {})},
                        stream,
                    )
            return self.run_result
        if command[1] == "path":
            return ProfileProcessResult(0, stdout=str(self.worktree))
        if command[1] == "stop":
            return ProfileProcessResult(0)
        raise AssertionError(f"unexpected abox command: {command}")


def _service(
    tmp_path: Path,
    fake: _FakeAbox,
    store: InMemoryArtifactStore | None = None,
) -> tuple[AboxProfileCaptureService, InMemoryArtifactStore]:
    selected_store = store or InMemoryArtifactStore()
    return (
        AboxProfileCaptureService(
            selected_store,
            command_executor=fake,
            scratch_root=tmp_path / "scratch",
            limits=CaptureLimits(timeout_seconds=15, max_artifact_bytes=1_000_000),
        ),
        selected_store,
    )


def test_fresh_abox_capture_preserves_pins_and_persists_artifact(tmp_path: Path) -> None:
    repo, revision = _repository(tmp_path)
    workload = _loaded(tmp_path)
    guest_worktree = tmp_path / "guest-worktree"
    guest_worktree.mkdir()
    fake = _FakeAbox(guest_worktree)
    service, store = _service(tmp_path, fake)

    snapshot = service.capture(
        workload,
        revision,
        _environment(),
        _profiler(),
        snapshot_id=_SNAPSHOT_ID,
    )

    assert snapshot.id == _SNAPSHOT_ID
    assert snapshot.workload == workload.pin
    assert snapshot.revision == revision
    assert snapshot.environment.profiler_adapter == "python.sampling"
    assert snapshot.hotspots[0].label == "hot"
    assert snapshot.hotspots[0].source_path == "hot.py"
    assert len(snapshot.artifacts) == 1
    assert len(store) == 1
    run = next(call for call in fake.calls if call[1] == "run")
    assert "sh" not in run
    assert run[run.index("--base") + 1] == revision.commit_sha
    assert "--input-file" in run
    assert fake.run_payload == {
        "argv": [
            "python",
            "-m",
            "cProfile",
            "-o",
            "/workspace/.bakudo/profile.raw",
            "-m",
            "hot",
        ],
        "cwd": "/workspace",
        "env": {"PYTHONHASHSEED": "0"},
    }
    assert any(call[1] == "stop" for call in fake.calls)
    assert list((tmp_path / "scratch").iterdir()) == []
    assert repo.is_dir()


def test_timeout_is_typed_and_still_cleans_fresh_task(tmp_path: Path) -> None:
    _repo, revision = _repository(tmp_path)
    workload = _loaded(tmp_path)
    guest_worktree = tmp_path / "guest-worktree"
    guest_worktree.mkdir()
    fake = _FakeAbox(
        guest_worktree,
        run_result=ProfileProcessResult(124, timed_out=True),
    )
    service, _store = _service(tmp_path, fake)

    with pytest.raises(ProfileTimeoutError, match="timed out"):
        service.capture(
            workload,
            revision,
            _environment(),
            _profiler(),
            snapshot_id=_SNAPSHOT_ID,
        )

    assert any(call[1] == "stop" for call in fake.calls)
    assert list((tmp_path / "scratch").iterdir()) == []


def test_tampered_workload_is_rejected_before_abox_execution(tmp_path: Path) -> None:
    _repo, revision = _repository(tmp_path)
    workload = _loaded(tmp_path)
    (workload.root / "README.txt").write_text("tampered\n")
    guest_worktree = tmp_path / "guest-worktree"
    guest_worktree.mkdir()
    fake = _FakeAbox(guest_worktree)
    service, _store = _service(tmp_path, fake)

    with pytest.raises(AboxProfileCaptureError, match="immutable pin"):
        service.capture(
            workload,
            revision,
            _environment(),
            _profiler(),
            snapshot_id=_SNAPSHOT_ID,
        )

    assert fake.calls == []


def test_revision_and_runtime_version_must_match_pins(tmp_path: Path) -> None:
    _repo, revision = _repository(tmp_path)
    workload = _loaded(tmp_path)
    guest_worktree = tmp_path / "guest-worktree"
    guest_worktree.mkdir()
    fake = _FakeAbox(guest_worktree)
    service, _store = _service(tmp_path, fake)

    with pytest.raises(AboxProfileCaptureError, match="revision"):
        service.capture(
            workload,
            revision.model_copy(update={"tree_digest": _DIGEST}),
            _environment(),
            _profiler(),
            snapshot_id=_SNAPSHOT_ID,
        )

    fake.calls.clear()
    with pytest.raises(AboxProfileCaptureError, match="runtime version"):
        service.capture(
            workload,
            revision,
            _environment(abox_version="0.7.0"),
            _profiler(),
            snapshot_id=_SNAPSHOT_ID,
        )
    assert any(call[1:] == ("--version",) for call in fake.calls)


def test_profiler_must_be_declared_by_pinned_workload(tmp_path: Path) -> None:
    _repo, revision = _repository(tmp_path)
    workload = _loaded(tmp_path)
    guest_worktree = tmp_path / "guest-worktree"
    guest_worktree.mkdir()
    fake = _FakeAbox(guest_worktree)
    service, _store = _service(tmp_path, fake)
    undeclared = ProfilerSpec(
        name="process",
        adapter="bakudo.process",
        signals=("wall-time",),
    )

    with pytest.raises(AboxProfileCaptureError, match="not declared"):
        service.capture(
            workload,
            revision,
            _environment(),
            undeclared,
            snapshot_id=_SNAPSHOT_ID,
        )

    assert fake.calls == []


def test_candidate_patch_is_verified_materialized_and_cleaned(tmp_path: Path) -> None:
    repo, baseline = _repository(tmp_path)
    (repo / "hot.py").write_text("def hot():\n    return 1\nhot()\n")
    patch = _git(repo, "diff", "--binary", baseline.commit_sha)
    revision = baseline.model_copy(
        update={
            "dirty": True,
            "base_commit_sha": baseline.commit_sha,
            "patch_digest": sha256_text(patch),
        }
    )
    assert revision.patch_digest is not None
    workload = _loaded(tmp_path)
    guest_worktree = tmp_path / "guest-worktree"
    guest_worktree.mkdir()
    fake = _FakeAbox(guest_worktree)
    service = AboxProfileCaptureService(
        InMemoryArtifactStore(),
        command_executor=fake,
        candidate_patches={revision.patch_digest: patch},
        scratch_root=tmp_path / "scratch",
    )

    service.capture(
        workload,
        revision,
        _environment(),
        _profiler(),
        snapshot_id=_SNAPSHOT_ID,
    )

    run = next(call for call in fake.calls if call[1] == "run")
    base_ref = run[run.index("--base") + 1]
    assert base_ref.startswith("profile/")
    branches = _git(repo, "branch", "--format=%(refname:short)").splitlines()
    assert base_ref not in branches
    assert list((tmp_path / "scratch").iterdir()) == []


def test_default_abox_executor_bounds_output_and_reports_timeout() -> None:
    bounded = bounded_abox_executor(
        [sys.executable, "-c", "print('x' * 10000)"],
        timeout=5,
        max_output_chars=17,
    )
    timed_out = bounded_abox_executor(
        [sys.executable, "-c", "import time; time.sleep(1)"],
        timeout=0.01,
        max_output_chars=10,
    )

    assert bounded.exit_code == 0
    assert len(bounded.stdout) == 17
    assert timed_out.exit_code == 124
    assert timed_out.timed_out


def test_cancellation_is_forwarded_and_task_is_cleaned(tmp_path: Path) -> None:
    _repo, revision = _repository(tmp_path)
    workload = _loaded(tmp_path)
    guest_worktree = tmp_path / "guest-worktree"
    guest_worktree.mkdir()
    event = threading.Event()
    event.set()

    class CancellingAbox(_FakeAbox):
        def __call__(
            self,
            argv: Sequence[str],
            *,
            timeout: float,
            max_output_chars: int,
            cancel_event: object | None = None,
        ) -> ProfileProcessResult:
            if len(argv) > 1 and argv[1] == "run":
                assert cancel_event is event
                self.calls.append(tuple(argv))
                return ProfileProcessResult(130)
            return super().__call__(
                argv,
                timeout=timeout,
                max_output_chars=max_output_chars,
                cancel_event=cancel_event,
            )

    fake = CancellingAbox(guest_worktree)
    service, _store = _service(tmp_path, fake)

    with pytest.raises(ProfileExecutionError, match="exited with code 130"):
        service.capture(
            workload,
            revision,
            _environment(),
            _profiler(),
            snapshot_id=_SNAPSHOT_ID,
            cancel_event=event,
        )

    assert any(call[1] == "stop" for call in fake.calls)
    assert list((tmp_path / "scratch").iterdir()) == []


def test_configured_capture_service_requires_durable_artifact_root(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("BAKUDO_ARTIFACT_ROOT", raising=False)
    with pytest.raises(AboxProfileCaptureError, match="BAKUDO_ARTIFACT_ROOT"):
        configured_profile_capture_service()

    artifact_root = tmp_path / "artifacts"
    monkeypatch.setenv("BAKUDO_ARTIFACT_ROOT", str(artifact_root))
    assert isinstance(configured_profile_capture_service(), AboxProfileCaptureService)
    assert artifact_root.is_dir()
