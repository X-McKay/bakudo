from __future__ import annotations

from pathlib import Path

import pytest
import yaml

from bakudo.performance.source import default_workload_source
from bakudo.performance.suite import (
    PerformanceSuiteLoadError,
    PerformanceSuiteSpec,
    resolve_performance_suite,
)
from bakudo.schema import validate_performance_suite_spec


def _document() -> dict:
    return {
        "apiVersion": "bakudo.ai/v1alpha1",
        "kind": "PerformanceSuiteSpec",
        "metadata": {"name": "smoke-analysis", "version": "1.0.0"},
        "scenarios": [
            {
                "name": "python-loop",
                "objective": "Keep the smoke loop fast without resource regressions.",
                "workload": {
                    "name": "smoke-python-loop",
                    "version": "1.0.1",
                    "source": "directory",
                },
                "primaryMetric": "latency_seconds",
                "minimumPairedSamples": 5,
                "profilerOnRegression": "synthetic",
            }
        ],
    }


def test_performance_suite_has_model_schema_and_workload_resolution_parity() -> None:
    document = _document()
    validate_performance_suite_spec(document)
    suite = PerformanceSuiteSpec.model_validate(document)
    validate_performance_suite_spec(suite.to_dict())

    resolution = resolve_performance_suite(suite, default_workload_source())

    assert resolution.suite_ref == "smoke-analysis@1.0.0"
    scenario = resolution.scenarios[0]
    assert scenario.workload.ref == "smoke-python-loop@1.0.1"
    assert scenario.primary_metric == "latency_seconds"


def test_performance_suite_rejects_invalid_policy_at_model_boundary() -> None:
    document = _document()
    document["scenarios"][0]["protectedMetrics"] = ["latency_seconds"]

    with pytest.raises(ValueError, match="primaryMetric cannot"):
        PerformanceSuiteSpec.model_validate(document)


def test_performance_suite_resolution_fails_for_unknown_workload_metric() -> None:
    document = _document()
    document["scenarios"][0]["primaryMetric"] = "unknown_metric"
    suite = PerformanceSuiteSpec.model_validate(document)

    with pytest.raises(PerformanceSuiteLoadError, match="lacks metrics: unknown_metric"):
        resolve_performance_suite(suite, default_workload_source())


def test_cli_validates_a_resolved_performance_suite(tmp_path: Path, capsys) -> None:
    from bakudo.cli import main

    suite = tmp_path / "suite.yaml"
    suite.write_text(yaml.safe_dump(_document(), sort_keys=False))

    assert main(["workload", "validate-suite", str(suite), "--json"]) == 0

    document = yaml.safe_load(capsys.readouterr().out)
    assert document["suiteRef"] == "smoke-analysis@1.0.0"
