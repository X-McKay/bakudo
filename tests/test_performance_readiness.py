from __future__ import annotations

import json
from pathlib import Path

import pytest

from bakudo.performance.readiness import (
    PerformanceRunnerReadinessError,
    inspect_performance_runner,
    require_trusted_performance_runner,
)

_DIGEST = "sha256:" + "a" * 64


def _environment(path: Path) -> Path:
    path.write_text(
        json.dumps(
            {
                "bakudoVersion": "3.0.0",
                "aboxVersion": "0.7.2",
                "imageDigest": _DIGEST,
                "profile": "python-glibc",
                "hardwareClass": "performance-lab",
                "architecture": "x86_64",
                "cpuCount": 4,
                "memoryMb": 4096,
                "os": "linux",
                "kernel": "test",
                "dependencyLockDigest": _DIGEST,
                "environmentDigest": _DIGEST,
            }
        )
    )
    return path


def _trusted_environment(path: Path) -> dict[str, str]:
    return {
        "BAKUDO_PERFORMANCE_RUNNER": "trusted",
        "BAKUDO_SANDBOX": "abox",
        "BAKUDO_POSTGRES_DSN": "postgresql://example.invalid/bakudo",
        "BAKUDO_WORKLOAD_SOURCE": "/srv/bakudo/workloads",
        "BAKUDO_PERFORMANCE_ENVIRONMENT": str(_environment(path)),
    }


def test_readiness_requires_an_explicit_trusted_runner_contract(tmp_path: Path) -> None:
    report = inspect_performance_runner(environ={}, find_executable=lambda _name: None)

    assert not report.ready
    assert report.environment is None
    assert any("BAKUDO_PERFORMANCE_RUNNER" in issue for issue in report.issues)
    assert any("BAKUDO_POSTGRES_DSN" in issue for issue in report.issues)
    assert any("BAKUDO_WORKLOAD_SOURCE" in issue for issue in report.issues)


def test_readiness_admits_an_explicit_non_github_lab_runner(tmp_path: Path) -> None:
    report = inspect_performance_runner(
        environ=_trusted_environment(tmp_path / "environment.json"),
        find_executable=lambda _name: "/usr/local/bin/abox",
    )

    assert report.ready
    assert report.environment is not None
    assert report.to_dict()["environmentDigest"] == _DIGEST


def test_readiness_checks_the_configured_abox_binary(tmp_path: Path) -> None:
    probed: list[str] = []

    def find(name: str) -> str | None:
        probed.append(name)
        return name if name == "/opt/abox/bin/abox" else None

    report = inspect_performance_runner(
        environ=_trusted_environment(tmp_path / "environment.json"),
        find_executable=find,
        abox_bin="/opt/abox/bin/abox",
    )

    assert report.ready
    assert probed == ["/opt/abox/bin/abox"]


def test_readiness_rejects_generic_github_hosted_runner_even_when_opted_in(
    tmp_path: Path,
) -> None:
    environ = _trusted_environment(tmp_path / "environment.json")
    environ.update({"GITHUB_ACTIONS": "true", "RUNNER_ENVIRONMENT": "github-hosted"})

    report = inspect_performance_runner(
        environ=environ,
        find_executable=lambda _name: "/usr/local/bin/abox",
    )

    assert not report.ready
    assert any("generic GitHub-hosted runners are forbidden" in issue for issue in report.issues)


def test_require_trusted_runner_fails_closed_for_default_configuration(monkeypatch) -> None:
    monkeypatch.delenv("BAKUDO_PERFORMANCE_RUNNER", raising=False)
    monkeypatch.delenv("BAKUDO_SANDBOX", raising=False)
    monkeypatch.delenv("BAKUDO_POSTGRES_DSN", raising=False)
    monkeypatch.delenv("BAKUDO_WORKLOAD_SOURCE", raising=False)
    monkeypatch.delenv("BAKUDO_PERFORMANCE_ENVIRONMENT", raising=False)

    with pytest.raises(PerformanceRunnerReadinessError, match="preflight failed"):
        require_trusted_performance_runner()
