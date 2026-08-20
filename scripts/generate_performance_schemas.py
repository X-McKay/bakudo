"""Regenerate performance JSON Schemas from the strict domain contracts."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from pydantic import TypeAdapter

from bakudo.performance.models import (
    MeasurementRecord,
    PerformanceComparison,
    PerformanceRegressionSignal,
    PerformanceSnapshot,
    WorkloadSpec,
)
from bakudo.performance.suite import PerformanceSuiteSpec

REPO_ROOT = Path(__file__).resolve().parents[1]
SCHEMA_ROOT = REPO_ROOT / "schemas"


def _write(
    name: str,
    schema: dict[str, object],
    *,
    schema_id: str,
    title: str,
    check: bool,
) -> None:
    document = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": schema_id,
        "title": title,
        **schema,
    }
    path = SCHEMA_ROOT / name
    rendered = json.dumps(document, indent=2, sort_keys=True) + "\n"
    if check:
        if not path.is_file() or path.read_text() != rendered:
            raise SystemExit(
                f"{path.relative_to(REPO_ROOT)} is stale; run "
                "python scripts/generate_performance_schemas.py"
            )
        return
    path.write_text(rendered)


def main(*, check: bool = False) -> None:
    workload = WorkloadSpec.model_json_schema(by_alias=True)
    _write(
        "workload-spec.schema.json",
        workload,
        schema_id="https://bakudo.ai/schemas/workload-spec.schema.json",
        title="WorkloadSpec",
        check=check,
    )

    suite = PerformanceSuiteSpec.model_json_schema(by_alias=True)
    _write(
        "performance-suite-spec.schema.json",
        suite,
        schema_id="https://bakudo.ai/schemas/performance-suite-spec.schema.json",
        title="PerformanceSuiteSpec",
        check=check,
    )

    record_type = (
        MeasurementRecord
        | PerformanceSnapshot
        | PerformanceComparison
        | PerformanceRegressionSignal
    )
    record = TypeAdapter(record_type).json_schema(by_alias=True)
    if "anyOf" in record:
        record["oneOf"] = record.pop("anyOf")
    _write(
        "performance-record.schema.json",
        record,
        schema_id="https://bakudo.ai/schemas/performance-record.schema.json",
        title="PerformanceRecord",
        check=check,
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--check",
        action="store_true",
        help="Fail without writing when a generated schema is stale.",
    )
    main(check=parser.parse_args().check)
