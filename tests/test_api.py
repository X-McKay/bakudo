"""Control API tests: full auth sweep (API-1/API-10), fail-closed sandbox
policy on execution routes (OPT-10), POST /runs body binding (API-8, guarding
the 37c5db6 body-resolution regression class), and 422 error mapping (API-9).
"""

import logging

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("httpx")

from fastapi.testclient import TestClient  # noqa: E402

from bakudo.api.server import build_app  # noqa: E402

TOKEN = "s3cret"
AUTH = {"Authorization": f"Bearer {TOKEN}"}
WRONG_AUTH = {"Authorization": "Bearer wrong"}

# (method, route template, concrete path, JSON body) — one entry per route.
# test_auth_matrix_covers_every_route ensures this stays exhaustive.
ROUTES = [
    ("POST", "/objectives", "/objectives", {"repo": "r", "type": "explore", "title": "t"}),
    ("GET", "/objectives", "/objectives", None),
    ("POST", "/runs", "/runs", {"objective_id": "obj_x", "agent": "explore"}),
    ("GET", "/runs/{run_id}", "/runs/run_x", None),
    ("GET", "/runs/{run_id}/logs", "/runs/run_x/logs", None),
    ("POST", "/optimize", "/optimize", {"repo": "r", "title": "t"}),
    (
        "POST",
        "/promotions/approve",
        "/promotions/approve",
        {"candidate": {"subject_type": "run", "subject_id": "r1", "overall_score": 0.9}},
    ),
    ("GET", "/promotions/pending", "/promotions/pending", None),
    ("GET", "/status", "/status", None),
]

ROUTE_IDS = [f"{m} {t}" for m, t, _, _ in ROUTES]


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    """Every test states its auth/sandbox posture explicitly."""
    for var in ("BAKUDO_API_TOKEN", "BAKUDO_SANDBOX", "BAKUDO_USE_ABOX", "BAKUDO_ENV"):
        monkeypatch.delenv(var, raising=False)


def _dev_local_sandbox(monkeypatch):
    monkeypatch.setenv("BAKUDO_SANDBOX", "local")
    monkeypatch.setenv("BAKUDO_ENV", "dev")
    monkeypatch.setenv("BAKUDO_OFFLINE", "1")


# --- API-1 / API-10: every route requires the bearer token when configured ---


def test_auth_matrix_covers_every_route():
    app = build_app()
    app_routes = {
        (method, route.path)
        for route in app.routes
        for method in getattr(route, "methods", set())
        if method != "HEAD"
        and route.path not in ("/openapi.json", "/docs", "/docs/oauth2-redirect", "/redoc")
    }
    assert app_routes == {(m, t) for m, t, _, _ in ROUTES}


@pytest.mark.parametrize("method,template,path,body", ROUTES, ids=ROUTE_IDS)
def test_route_401_without_token(monkeypatch, method, template, path, body):
    monkeypatch.setenv("BAKUDO_API_TOKEN", TOKEN)
    client = TestClient(build_app())
    assert client.request(method, path, json=body).status_code == 401
    assert client.request(method, path, json=body, headers=WRONG_AUTH).status_code == 401


@pytest.mark.parametrize("method,template,path,body", ROUTES, ids=ROUTE_IDS)
def test_route_admits_correct_token(monkeypatch, method, template, path, body):
    monkeypatch.setenv("BAKUDO_API_TOKEN", TOKEN)
    client = TestClient(build_app())
    resp = client.request(method, path, json=body, headers=AUTH)
    assert resp.status_code not in (401, 403), resp.text


@pytest.mark.parametrize("method,template,path,body", ROUTES, ids=ROUTE_IDS)
def test_route_fail_open_when_token_unset(method, template, path, body):
    client = TestClient(build_app())
    resp = client.request(method, path, json=body)
    assert resp.status_code not in (401, 403), resp.text


def test_startup_warns_once_when_auth_disabled(caplog):
    with caplog.at_level(logging.WARNING, logger="bakudo.api.server"):
        build_app()
    warnings = [r for r in caplog.records if "API auth disabled" in r.getMessage()]
    assert len(warnings) == 1
    assert "BAKUDO_API_TOKEN" in warnings[0].getMessage()


def test_startup_does_not_warn_when_token_set(monkeypatch, caplog):
    monkeypatch.setenv("BAKUDO_API_TOKEN", TOKEN)
    with caplog.at_level(logging.WARNING, logger="bakudo.api.server"):
        build_app()
    assert not [r for r in caplog.records if "API auth disabled" in r.getMessage()]


def test_correct_token_round_trip(monkeypatch):
    monkeypatch.setenv("BAKUDO_API_TOKEN", TOKEN)
    client = TestClient(build_app())
    ok = client.post(
        "/objectives", json={"repo": "r", "type": "explore", "title": "map"}, headers=AUTH
    )
    assert ok.status_code == 200
    assert ok.json()["id"].startswith("obj_")


# --- OPT-10: execution routes honour the fail-closed sandbox policy ---


def test_optimize_409_when_sandbox_unset():
    client = TestClient(build_app())
    resp = client.post("/optimize", json={"repo": "r", "title": "t"})
    assert resp.status_code == 409
    assert "BAKUDO_SANDBOX" in resp.json()["detail"]


def test_optimize_409_when_local_sandbox_outside_dev(monkeypatch):
    monkeypatch.setenv("BAKUDO_SANDBOX", "local")
    client = TestClient(build_app())
    resp = client.post("/optimize", json={"repo": "r", "title": "t"})
    assert resp.status_code == 409
    assert "BAKUDO_ENV" in resp.json()["detail"]


def test_optimize_409_on_unknown_sandbox_value(monkeypatch):
    monkeypatch.setenv("BAKUDO_SANDBOX", "bogus")
    client = TestClient(build_app())
    assert client.post("/optimize", json={"repo": "r", "title": "t"}).status_code == 409


def test_runs_409_when_sandbox_unset():
    client = TestClient(build_app())
    resp = client.post("/runs", json={"objective_id": "obj_x", "agent": "explore"})
    assert resp.status_code == 409
    assert "BAKUDO_SANDBOX" in resp.json()["detail"]


def test_runs_409_when_local_sandbox_outside_dev(monkeypatch):
    monkeypatch.setenv("BAKUDO_SANDBOX", "local")
    client = TestClient(build_app())
    resp = client.post("/runs", json={"objective_id": "obj_x", "agent": "explore"})
    assert resp.status_code == 409


def test_optimize_threads_resolved_sandbox_into_loop(monkeypatch):
    _dev_local_sandbox(monkeypatch)
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
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "no-change"
    assert body["objective_id"].startswith("obj_")

    from bakudo.abox.local import local_sandbox

    assert captured["kwargs"]["sandbox"] is local_sandbox
    objective = captured["objective"]
    assert objective.type.value == "optimize"
    assert objective.constraints.bench_command == "pytest tests/benchmarks -q"
    assert objective.constraints.target_paths == ["src/ledger/**"]
    assert captured["kwargs"]["max_rounds"] == 4


# --- API-8: POST /runs takes a JSON body and knows the repo's seed agents ---


def test_spawn_run_with_json_body_end_to_end(monkeypatch):
    _dev_local_sandbox(monkeypatch)
    client = TestClient(build_app())
    obj = client.post(
        "/objectives",
        json={
            "repo": "bakudo",
            "type": "explore",
            "title": "Map the repository.",
            "acceptanceCriteria": ["Produce a structured result.json"],
        },
    )
    assert obj.status_code == 200
    resp = client.post("/runs", json={"objective_id": obj.json()["id"], "agent": "explore"})
    assert resp.status_code == 200, resp.text
    run_id = resp.json()["run_id"]
    assert run_id.startswith("run_")
    assert client.get(f"/runs/{run_id}").status_code == 200
    assert client.get(f"/runs/{run_id}/logs").status_code == 200


def test_spawn_run_unknown_agent_is_404(monkeypatch):
    _dev_local_sandbox(monkeypatch)
    client = TestClient(build_app())
    obj = client.post("/objectives", json={"repo": "r", "type": "explore", "title": "t"})
    resp = client.post("/runs", json={"objective_id": obj.json()["id"], "agent": "nope"})
    assert resp.status_code == 404
    assert "nope" in resp.json()["detail"]


def test_spawn_run_unknown_objective_is_404(monkeypatch):
    _dev_local_sandbox(monkeypatch)
    client = TestClient(build_app())
    resp = client.post("/runs", json={"objective_id": "obj_missing", "agent": "explore"})
    assert resp.status_code == 404


def test_openapi_shows_request_bodies_not_query_params():
    """Guard for the 37c5db6 regression class: POST bodies must bind as
    request bodies, not degrade to query parameters."""
    client = TestClient(build_app())
    schema = client.get("/openapi.json").json()
    for path, fields in (
        ("/objectives", ("repo", "type", "title")),
        ("/runs", ("objective_id", "agent")),
        ("/optimize", ("repo", "title")),
    ):
        post = schema["paths"][path]["post"]
        assert "requestBody" in post, f"{path} lost its request body"
        query_params = {
            p["name"] for p in post.get("parameters", []) if p.get("in") == "query"
        }
        assert not query_params.intersection(fields), (
            f"{path} binds {query_params & set(fields)} as query params"
        )


# --- API-9: invalid inputs are 422, not 500 ---


def test_bad_queue_value_is_422():
    client = TestClient(build_app())
    resp = client.get("/objectives", params={"queue": "bogus"})
    assert resp.status_code == 422
    detail = resp.json()["detail"]
    assert "bogus" in detail
    assert "ready" in detail  # names the valid queues


def test_invalid_scorecard_payload_is_422():
    client = TestClient(build_app())
    resp = client.post("/promotions/approve", json={"candidate": {"overall_score": 3.0}})
    assert resp.status_code == 422


def test_invalid_objective_payload_is_422():
    client = TestClient(build_app())
    resp = client.post("/objectives", json={"repo": "r", "type": "not-a-type", "title": "t"})
    assert resp.status_code == 422


# --- reads still work with auth disabled ---


def test_read_routes_open_and_pending_promotions_empty():
    client = TestClient(build_app())
    assert client.get("/status").status_code == 200
    assert client.get("/promotions/pending").json() == []
