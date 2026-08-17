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
