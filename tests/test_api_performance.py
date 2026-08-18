from __future__ import annotations

import pytest
import yaml

pytest.importorskip("fastapi")
pytest.importorskip("httpx")

from fastapi.testclient import TestClient  # noqa: E402

from bakudo.api.server import build_app  # noqa: E402
from bakudo.control import MetaAgentTools  # noqa: E402
from bakudo.paths import smoke_workloads_dir  # noqa: E402
from bakudo.performance.models import (  # noqa: E402
    FailureReason,
    MeasurementRecord,
    RecordStatus,
    canonical_digest,
)
from bakudo.performance.pins import EnvironmentPin, RevisionPin  # noqa: E402
from bakudo.performance.source import default_workload_source  # noqa: E402

_DIGEST = "sha256:" + "a" * 64


class _Dispatcher:
    def __init__(self) -> None:
        self.requests = []

    def start_measurement(self, request) -> str:
        self.requests.append(request)
        return "workflow_measurement"

    def start_capture(self, request) -> str:
        self.requests.append(request)
        return "workflow_capture"

    def start_comparison(self, request) -> str:
        self.requests.append(request)
        return "workflow_comparison"


def _environment() -> EnvironmentPin:
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
    )


def test_workload_routes_list_and_validate_packaged_smoke() -> None:
    client = TestClient(build_app())

    listed = client.get("/workloads")
    assert listed.status_code == 200
    assert [item["ref"] for item in listed.json()] == ["smoke-python-loop@1.0.1"]

    document = yaml.safe_load(
        (smoke_workloads_dir() / "python-loop" / "workload.yaml").read_text()
    )
    validated = client.post("/workloads/validate", json={"document": document})
    assert validated.status_code == 200
    assert validated.json()["ref"] == "smoke-python-loop@1.0.1"
    assert validated.json()["manifestDigest"].startswith("sha256:")


def test_performance_create_routes_return_durable_operation_ids() -> None:
    dispatcher = _Dispatcher()
    client = TestClient(build_app(performance_dispatcher=dispatcher))
    common = {"repository": "repo", "workload": "smoke", "environment": {}}

    measurement = client.post("/performance/measurements", json=common)
    capture = client.post("/performance/captures", json={**common, "profiler": "synthetic"})
    comparison = client.post(
        "/performance/comparisons",
        json={
            **common,
            "baselineRevision": "main",
            "candidateRevision": "candidate",
        },
    )

    assert measurement.status_code == capture.status_code == comparison.status_code == 202
    assert measurement.json() == {"operation_id": "workflow_measurement"}
    assert capture.json() == {"operation_id": "workflow_capture"}
    assert comparison.json() == {"operation_id": "workflow_comparison"}
    assert len(dispatcher.requests) == 3


def test_unconfigured_performance_dispatch_fails_with_actionable_conflict() -> None:
    response = TestClient(build_app()).post(
        "/performance/measurements",
        json={"repository": "repo", "workload": "smoke", "environment": {}},
    )

    assert response.status_code == 409
    assert "Temporal" in response.json()["detail"]
    assert "--sync" in response.json()["detail"]


def test_performance_record_read_uses_authoritative_ledger() -> None:
    tools = MetaAgentTools()
    loaded = default_workload_source().load("smoke-python-loop")
    record = MeasurementRecord(
        workload=loaded.pin,
        revision=RevisionPin(
            repository="bakudo-smoke",
            source_uri="file:///repo",
            commit_sha="a" * 40,
            tree_digest=_DIGEST,
        ),
        environment=_environment(),
        plan_digest=canonical_digest(loaded.spec.measurement),
        status=RecordStatus.unsupported,
        failure_reason=FailureReason.unsupported,
    )
    tools.ledger.record_measurement(record)
    client = TestClient(build_app(tools))

    response = client.get(f"/performance/records/{record.id}")

    assert response.status_code == 200
    assert response.json()["id"] == record.id
    assert response.json()["kind"] == "MeasurementRecord"
