from __future__ import annotations

import json

import pytest

from bakudo.performance.environment import (
    EnvironmentPinLoadError,
    configured_environment_pin,
    load_environment_pin,
)

_DIGEST = "sha256:" + "a" * 64


def _document() -> dict[str, object]:
    return {
        "bakudoVersion": "3.0.0",
        "aboxVersion": "0.7.1",
        "imageDigest": _DIGEST,
        "profile": "python-glibc",
        "hardwareClass": "local-test",
        "architecture": "arm64",
        "cpuCount": 1,
        "memoryMb": 256,
        "os": "linux",
        "kernel": "test",
        "dependencyLockDigest": _DIGEST,
        "environmentDigest": _DIGEST,
    }


def test_environment_pin_loads_json_and_env_configuration(tmp_path, monkeypatch) -> None:
    path = tmp_path / "environment.json"
    path.write_text(json.dumps(_document()))
    monkeypatch.setenv("BAKUDO_PERFORMANCE_ENVIRONMENT", str(path))

    assert load_environment_pin(path).profile == "python-glibc"
    assert configured_environment_pin().profile == "python-glibc"


def test_environment_pin_requires_explicit_configuration(monkeypatch) -> None:
    monkeypatch.delenv("BAKUDO_PERFORMANCE_ENVIRONMENT", raising=False)

    with pytest.raises(EnvironmentPinLoadError, match="--environment"):
        configured_environment_pin()
