"""Unit tests for the read-only environment diagnostics component."""

from __future__ import annotations

from bakudo.doctor import DiagnosticCheck, DoctorReport, build_doctor_report


def test_doctor_report_aggregates_statuses():
    report = DoctorReport(
        (
            DiagnosticCheck("ready", "ok", "ready"),
            DiagnosticCheck("optional", "warning", "optional integration missing"),
            DiagnosticCheck("broken", "error", "required input missing"),
        )
    )

    assert report.ok is False
    assert report.warning_count == 1
    assert report.error_count == 1
    assert report.to_dict()["checks"][0]["name"] == "ready"


def test_doctor_reports_invalid_execution_configuration(monkeypatch):
    monkeypatch.setenv("BAKUDO_OFFLINE", "sometimes")

    report = build_doctor_report()
    execution = next(check for check in report.checks if check.name == "execution")

    assert report.ok is False
    assert execution.status == "error"
    assert "must be 0 or 1" in execution.detail


def test_doctor_explains_default_workload_and_artifact_posture(monkeypatch):
    monkeypatch.delenv("BAKUDO_WORKLOAD_SOURCE", raising=False)
    monkeypatch.delenv("BAKUDO_ARTIFACT_ROOT", raising=False)

    report = build_doctor_report()
    checks = {check.name: check for check in report.checks}

    assert checks["workload-source"].status == "warning"
    assert "packaged smoke fallback" in checks["workload-source"].detail
    assert checks["performance-artifacts"].status == "warning"
    assert "BAKUDO_ARTIFACT_ROOT" in checks["performance-artifacts"].detail
    assert "performance-runner" in checks
    assert checks["performance-environment"].status == "warning"
    assert "performance-profilers" in checks


def test_doctor_reports_configured_artifact_root(tmp_path, monkeypatch):
    root = tmp_path / "profiles"
    root.mkdir()
    monkeypatch.setenv("BAKUDO_ARTIFACT_ROOT", str(root))

    report = build_doctor_report()
    artifact = next(check for check in report.checks if check.name == "performance-artifacts")

    assert artifact.status == "ok"
    assert str(root) in artifact.detail
