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
