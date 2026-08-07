"""Phase D3: API bearer auth and the human-approval queue endpoint."""

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("httpx")

from fastapi.testclient import TestClient  # noqa: E402

from bakudo.api.server import build_app  # noqa: E402


def test_mutating_route_requires_token(monkeypatch):
    monkeypatch.setenv("BAKUDO_API_TOKEN", "s3cret")
    client = TestClient(build_app())
    body = {"repo": "r", "type": "explore", "title": "map"}

    # Missing/incorrect token is rejected on a mutating route.
    assert client.post("/objectives", json=body).status_code == 401
    assert client.post(
        "/objectives", json=body, headers={"Authorization": "Bearer wrong"}
    ).status_code == 401

    # Correct token succeeds.
    ok = client.post("/objectives", json=body, headers={"Authorization": "Bearer s3cret"})
    assert ok.status_code == 200
    assert ok.json()["id"].startswith("obj_")


def test_read_routes_open_and_pending_promotions_empty(monkeypatch):
    monkeypatch.delenv("BAKUDO_API_TOKEN", raising=False)
    client = TestClient(build_app())
    # With auth disabled, reads work and the approval queue starts empty.
    assert client.get("/status").status_code == 200
    assert client.get("/promotions/pending").json() == []


def test_optimize_route_accepts_and_reports_result(monkeypatch):
    import time

    monkeypatch.delenv("BAKUDO_API_TOKEN", raising=False)
    captured: dict = {}

    def fake_loop(objective, scout_spec, attempt_spec, **kwargs):
        captured["objective"] = objective
        captured["kwargs"] = kwargs
        return {"status": "no-change", "rounds_used": 1, "reason": "stub"}

    monkeypatch.setattr("bakudo.control.optimize.run_optimize_loop", fake_loop)
    client = TestClient(build_app())
    resp = client.post(
        "/optimize",
        json={
            "repo": "payments-api",
            "title": "Optimize dedup",
            "benchCommand": "pytest tests/benchmarks -q",
            "targetPaths": ["src/ledger/**"],
            "maxFilesChanged": 3,
            "maxRounds": 4,
        },
    )
    # The API accepts and hands back a poll URL instead of blocking (202).
    assert resp.status_code == 202
    accepted = resp.json()
    assert accepted["objective_id"].startswith("obj_")
    assert accepted["status_url"] == f"/optimize/{accepted['objective_id']}"

    deadline = time.monotonic() + 10
    body = {"status": "running"}
    while body.get("status") == "running" and time.monotonic() < deadline:
        body = client.get(accepted["status_url"]).json()
        time.sleep(0.02)
    assert body["status"] == "no-change"

    objective = captured["objective"]
    assert objective.type.value == "optimize"
    assert objective.constraints.bench_command == "pytest tests/benchmarks -q"
    assert objective.constraints.target_paths == ["src/ledger/**"]
    assert captured["kwargs"]["max_rounds"] == 4


def test_optimize_status_unknown_job_is_404(monkeypatch):
    monkeypatch.delenv("BAKUDO_API_TOKEN", raising=False)
    client = TestClient(build_app())
    assert client.get("/optimize/obj_nope").status_code == 404


def test_optimize_route_requires_token_when_configured(monkeypatch):
    monkeypatch.setenv("BAKUDO_API_TOKEN", "s3cret")
    client = TestClient(build_app())
    body = {"repo": "r", "title": "optimize x"}
    assert client.post("/optimize", json=body).status_code == 401
