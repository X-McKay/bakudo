from __future__ import annotations

import subprocess
from pathlib import Path

from bakudo.api.server import (
    PerformanceCaptureIn,
    PerformanceComparisonIn,
    PerformanceMeasurementIn,
)
from bakudo.performance.pins import EnvironmentPin
from bakudo.registry.ledger import InMemoryLedger
from bakudo.temporal.performance_dispatch import TemporalPerformanceDispatcher

_DIGEST = "sha256:" + "a" * 64


def _git(repo: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(repo), *args],
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def _repo(tmp_path: Path) -> tuple[Path, str]:
    repo = tmp_path / "bakudo-smoke"
    repo.mkdir()
    _git(repo, "init", "-q")
    _git(repo, "config", "user.email", "test@bakudo.invalid")
    _git(repo, "config", "user.name", "Bakudo Test")
    (repo / "value.txt").write_text("baseline\n")
    _git(repo, "add", "value.txt")
    _git(repo, "commit", "-qm", "baseline")
    baseline = _git(repo, "rev-parse", "HEAD")
    (repo / "value.txt").write_text("candidate\n")
    _git(repo, "commit", "-qam", "candidate")
    return repo, baseline


def _environment() -> dict:
    return EnvironmentPin(
        bakudo_version="3.0.0",
        abox_version="0.7.2",
        image_digest=_DIGEST,
        profile="python-glibc",
        hardware_class="test",
        architecture="arm64",
        cpu_count=1,
        memory_mb=256,
        os="linux",
        kernel="test",
        dependency_lock_digest=_DIGEST,
        environment_digest=_DIGEST,
    ).model_dump(by_alias=True, mode="json")


class _Client:
    def __init__(self) -> None:
        self.started = []

    async def start_workflow(self, workflow_run, inp, **options):
        self.started.append((workflow_run, inp, options))
        return object()


def test_dispatcher_pins_inputs_and_starts_all_performance_workflows(tmp_path: Path) -> None:
    repo, baseline = _repo(tmp_path)
    client = _Client()

    async def client_factory():
        return client

    ledger = InMemoryLedger()
    dispatcher = TemporalPerformanceDispatcher(ledger, client_factory=client_factory)
    common = {
        "repository": str(repo),
        "workload": "smoke-python-loop",
        "environment": _environment(),
    }

    measurement = dispatcher.start_measurement(PerformanceMeasurementIn(**common))
    capture = dispatcher.start_capture(
        PerformanceCaptureIn(**common, profiler="synthetic")
    )
    comparison = dispatcher.start_comparison(
        PerformanceComparisonIn(
            **common,
            baselineRevision=baseline,
            candidateRevision="HEAD",
        )
    )

    assert measurement.startswith("operation_")
    assert capture.startswith("operation_")
    assert comparison.startswith("operation_")
    assert len({measurement, capture, comparison}) == 3
    assert len(client.started) == 3
    assert all(call[2]["id"].startswith("performance-operation_") for call in client.started)
    assert client.started[0][1].workload_pin["bundleDigest"].startswith("sha256:")
    assert client.started[0][1].workload_source == "package://bakudo/smoke-workloads"
    assert client.started[0][1].revision["commitSHA"] == _git(repo, "rev-parse", "HEAD")
    assert client.started[2][1].baseline_revision["commitSHA"] == baseline
    assert client.started[2][1].candidate_revision["commitSHA"] == _git(
        repo, "rev-parse", "HEAD"
    )
    stored = ledger.get_workload_version("smoke-python-loop@1.0.1")
    assert stored is not None
