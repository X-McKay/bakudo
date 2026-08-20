from __future__ import annotations

import json
import subprocess
from pathlib import Path

from bakudo.cli import main
from bakudo.performance.models import (
    InvocationOutcome,
    MetricValue,
    PerformanceSnapshot,
    ProfilerDescriptor,
    RecordStatus,
    canonical_digest,
)
from bakudo.registry.ledger import InMemoryLedger

_DIGEST = "sha256:" + "a" * 64


def test_workload_list_defaults_to_packaged_smoke_corpus(capsys) -> None:
    assert main(["workload", "list", "--json"]) == 0

    records = json.loads(capsys.readouterr().out)
    assert [record["ref"] for record in records] == ["smoke-python-loop@1.0.1"]
    assert records[0]["sourceURI"] == "package://bakudo/smoke-workloads"


def test_workload_inspect_exposes_spec_pin_and_provenance(capsys) -> None:
    assert main(["workload", "inspect", "smoke-python-loop", "--json"]) == 0

    record = json.loads(capsys.readouterr().out)
    assert record["spec"]["kind"] == "WorkloadSpec"
    assert record["pin"]["bundleDigest"].startswith("sha256:")
    assert record["provenance"]["collectionRevision"] == "packaged-smoke-v1"


def test_workload_validate_accepts_directory_or_manifest(capsys) -> None:
    workload = Path(__file__).parents[1] / "smoke" / "workloads" / "python-loop"

    assert main(["workload", "validate", str(workload / "workload.yaml"), "--json"]) == 0

    record = json.loads(capsys.readouterr().out)
    assert record["ok"] is True
    assert record["ref"] == "smoke-python-loop@1.0.1"


def test_workload_validate_reports_clean_error(tmp_path, capsys) -> None:
    broken = tmp_path / "broken"
    broken.mkdir()

    assert main(["workload", "validate", str(broken)]) == 1
    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err.startswith("error: ")


class _FakeAboxWorkloadInvoker:
    def __init__(self, **_kwargs) -> None:
        pass

    def invoke(self, workload, revision, environment, *, phase, ordinal):
        del revision, environment
        definition = workload.spec.measurement.metrics[0]
        return InvocationOutcome(
            ordinal=ordinal,
            phase=phase,
            status=RecordStatus.completed,
            elapsed_seconds=0.01,
            exit_code=0,
            metrics=(MetricValue(name=definition.name, unit=definition.unit, value=0.01),),
        )


class _FakeCaptureService:
    def capture(
        self,
        workload,
        revision,
        environment,
        profiler,
        *,
        snapshot_id,
        cancel_event=None,
    ):
        del cancel_event
        return PerformanceSnapshot(
            id=snapshot_id,
            workload=workload.pin,
            revision=revision,
            environment=environment.model_copy(
                update={
                    "profiler_adapter": profiler.adapter,
                    "profiler_version": "1",
                }
            ),
            profiler_spec_digest=canonical_digest(profiler),
            descriptor=ProfilerDescriptor(
                name=profiler.name,
                adapter=profiler.adapter,
                version="1",
            ),
            capture_seconds=0.1,
            sanitization_status="sanitized",
            status=RecordStatus.completed,
        )


def _git(repo: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True)


def _performance_fixture(tmp_path: Path) -> tuple[Path, Path]:
    repo = tmp_path / "bakudo-smoke"
    repo.mkdir()
    _git(repo, "init", "-q")
    _git(repo, "config", "user.email", "test@example.com")
    _git(repo, "config", "user.name", "Test")
    (repo / "app.py").write_text("value = 1\n")
    _git(repo, "add", "app.py")
    _git(repo, "commit", "-q", "-m", "initial")
    environment = tmp_path / "environment.json"
    environment.write_text(
        json.dumps(
            {
                "bakudoVersion": "3.0.0",
                "aboxVersion": "0.7.2",
                "imageDigest": _DIGEST,
                "profile": "python-glibc",
                "hardwareClass": "test",
                "architecture": "arm64",
                "cpuCount": 1,
                "memoryMb": 256,
                "os": "linux",
                "kernel": "test",
                "dependencyLockDigest": _DIGEST,
                "environmentDigest": _DIGEST,
            }
        )
    )
    return repo, environment


def test_performance_measure_sync_emits_record_and_show_reads_same_ledger(
    tmp_path, monkeypatch, capsys
) -> None:
    from bakudo.abox import measurement
    from bakudo.registry import factory

    repo, environment = _performance_fixture(tmp_path)
    ledger = InMemoryLedger()
    monkeypatch.setattr(measurement, "AboxWorkloadInvoker", _FakeAboxWorkloadInvoker)
    monkeypatch.setattr(factory, "ledger_from_env", lambda: ledger)

    assert (
        main(
            [
                "performance",
                "measure",
                "--repo",
                str(repo),
                "--workload",
                "smoke-python-loop",
                "--environment",
                str(environment),
                "--sync",
                "--json",
            ]
        )
        == 0
    )
    captured = capsys.readouterr()
    record = json.loads(captured.out)
    assert record["kind"] == "MeasurementRecord"
    assert record["status"] == "completed"
    # The resolved pin is echoed so an operator sees the exact revision the
    # evidence binds to, not the mutable ref they typed.
    head = subprocess.run(
        ["git", "-C", str(repo), "rev-parse", "HEAD"], check=True, capture_output=True, text=True
    ).stdout.strip()
    assert f"pinned HEAD -> {head}" in captured.err

    assert main(["performance", "show", record["id"], "--json"]) == 0
    shown = json.loads(capsys.readouterr().out)
    assert shown == record


def test_performance_capture_sync_persists_diagnostic_snapshot(
    tmp_path, monkeypatch, capsys
) -> None:
    from bakudo.abox import capture, measurement
    from bakudo.registry import factory

    repo, environment = _performance_fixture(tmp_path)
    ledger = InMemoryLedger()
    monkeypatch.setattr(measurement, "AboxWorkloadInvoker", _FakeAboxWorkloadInvoker)
    monkeypatch.setattr(
        capture,
        "configured_profile_capture_service",
        lambda **_kwargs: _FakeCaptureService(),
    )
    monkeypatch.setattr(factory, "ledger_from_env", lambda: ledger)

    assert (
        main(
            [
                "performance",
                "capture",
                "--repo",
                str(repo),
                "--workload",
                "smoke-python-loop",
                "--environment",
                str(environment),
                "--profiler",
                "synthetic",
                "--sync",
                "--json",
            ]
        )
        == 0
    )
    record = json.loads(capsys.readouterr().out)
    assert record["kind"] == "PerformanceSnapshot"
    assert record["descriptor"]["name"] == "synthetic"
    assert ledger.get_performance_snapshot(record["id"]) is not None


def test_profile_diff_is_persisted_snapshot_diagnostics_only(tmp_path, monkeypatch, capsys) -> None:
    from bakudo.abox import capture, measurement
    from bakudo.registry import factory

    repo, environment = _performance_fixture(tmp_path)
    ledger = InMemoryLedger()
    monkeypatch.setattr(measurement, "AboxWorkloadInvoker", _FakeAboxWorkloadInvoker)
    monkeypatch.setattr(
        capture,
        "configured_profile_capture_service",
        lambda **_kwargs: _FakeCaptureService(),
    )
    monkeypatch.setattr(factory, "ledger_from_env", lambda: ledger)
    capture_args = [
        "performance",
        "capture",
        "--repo",
        str(repo),
        "--workload",
        "smoke-python-loop",
        "--environment",
        str(environment),
        "--profiler",
        "synthetic",
        "--sync",
        "--json",
    ]

    assert main(capture_args) == 0
    baseline = json.loads(capsys.readouterr().out)
    assert main(capture_args) == 0
    candidate = json.loads(capsys.readouterr().out)

    assert (
        main(
            [
                "performance",
                "profile-diff",
                "--baseline-snapshot-id",
                baseline["id"],
                "--candidate-snapshot-id",
                candidate["id"],
                "--json",
            ]
        )
        == 0
    )
    report = json.loads(capsys.readouterr().out)
    assert report["kind"] == "DiagnosticProfileComparison"
    assert report["diagnosticOnly"] is True
    assert report["hotspots"] == []


def test_performance_execution_requires_explicit_sync_mode(capsys) -> None:
    assert (
        main(
            [
                "performance",
                "measure",
                "--repo",
                "missing",
                "--workload",
                "smoke-python-loop",
            ]
        )
        == 2
    )
    assert "select an execution mode with --sync" in capsys.readouterr().err


def test_performance_preflight_reports_an_unconfigured_runner(monkeypatch, capsys) -> None:
    for name in (
        "BAKUDO_PERFORMANCE_RUNNER",
        "BAKUDO_SANDBOX",
        "BAKUDO_POSTGRES_DSN",
        "BAKUDO_WORKLOAD_SOURCE",
        "BAKUDO_PERFORMANCE_ENVIRONMENT",
    ):
        monkeypatch.delenv(name, raising=False)

    assert main(["performance", "preflight", "--json"]) == 2
    report = json.loads(capsys.readouterr().out)
    assert report["ready"] is False
    assert any("BAKUDO_PERFORMANCE_RUNNER" in issue for issue in report["issues"])


def test_performance_prescreen_is_labeled_untrusted_and_never_persists(
    tmp_path, monkeypatch, capsys
) -> None:
    from bakudo.performance import prescreen
    from bakudo.registry import factory

    repo, _environment = _performance_fixture(tmp_path)
    ledger = InMemoryLedger()
    monkeypatch.setattr(factory, "ledger_from_env", lambda: ledger)

    result = prescreen.PrescreenResult(
        workload_ref="smoke-python-loop@1.0.1",
        baseline=prescreen.PrescreenSide("main", "a" * 40, (1.0, 1.02)),
        candidate=prescreen.PrescreenSide("cand", "b" * 40, (0.8, 0.81)),
    )
    seen: dict[str, object] = {}

    def fake_run(repo_path, workload, baseline_ref, candidate_ref, *, runs, python):
        seen.update(
            repo=repo_path, workload=workload.ref, refs=(baseline_ref, candidate_ref), runs=runs
        )
        return result

    monkeypatch.setattr(prescreen, "run_prescreen", fake_run)

    assert (
        main(
            [
                "performance",
                "prescreen",
                "--repo",
                str(repo),
                "--workload",
                "smoke-python-loop",
                "--baseline-ref",
                "main",
                "--candidate-ref",
                "cand",
                "--json",
            ]
        )
        == 0
    )
    captured = capsys.readouterr()
    assert "UNTRUSTED host prescreen" in captured.err
    document = json.loads(captured.out)
    assert document["evidence"] is False
    assert document["verdict"] == "likely-improvement"
    assert seen["refs"] == ("main", "cand")
    assert seen["runs"] == 6
    assert ledger.list_performance_comparisons() == []


def test_performance_calibrate_passes_on_an_equivalent_aa_comparison(
    tmp_path, monkeypatch, capsys
) -> None:
    from bakudo.abox import measurement
    from bakudo.registry import factory

    repo, environment = _performance_fixture(tmp_path)
    ledger = InMemoryLedger()
    monkeypatch.setattr(measurement, "AboxWorkloadInvoker", _FakeAboxWorkloadInvoker)
    monkeypatch.setattr(factory, "ledger_from_env", lambda: ledger)

    assert (
        main(
            [
                "performance",
                "calibrate",
                "--repo",
                str(repo),
                "--workload",
                "smoke-python-loop",
                "--environment",
                str(environment),
                "--sync",
                "--json",
            ]
        )
        == 0
    )
    captured = capsys.readouterr()
    comparison = json.loads(captured.out)
    assert comparison["verdict"] == "equivalent"
    assert (
        comparison["baselineRevision"]["commitSHA"] == comparison["candidateRevision"]["commitSHA"]
    )
    assert "calibration passed" in captured.err

    # The persisted comparison renders as a PR-ready evidence block.
    assert main(["performance", "report", comparison["id"]]) == 0
    markdown = capsys.readouterr().out
    assert "**Verdict: equivalent**" in markdown
    assert comparison["workload"]["bundleDigest"] in markdown
    assert comparison["baselineRevision"]["commitSHA"] in markdown
    assert "| `latency_seconds` | primary |" in markdown


def test_performance_report_missing_comparison_fails_cleanly(monkeypatch, capsys) -> None:
    from bakudo.registry import factory

    monkeypatch.setattr(factory, "ledger_from_env", lambda: InMemoryLedger())

    assert main(["performance", "report", "comparison_" + "2" * 26]) == 1
    assert "not found" in capsys.readouterr().err
