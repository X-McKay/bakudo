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
OPTIMIZE_BODY = {
    "repo": "r",
    "title": "t",
    "performance": {
        "workloadRef": {
            "name": "smoke-python-loop",
            "version": "1.0.0",
            "source": "directory",
        },
        "primaryMetric": "latency_seconds",
    },
}

# (method, route template, concrete path, JSON body) — one entry per route.
# test_auth_matrix_covers_every_route ensures this stays exhaustive.
ROUTES = [
    ("GET", "/workloads", "/workloads", None),
    ("POST", "/workloads/validate", "/workloads/validate", {"document": {}}),
    (
        "POST",
        "/performance/measurements",
        "/performance/measurements",
        {"repository": "r", "workload": "w", "environment": {}},
    ),
    (
        "POST",
        "/performance/captures",
        "/performance/captures",
        {"repository": "r", "workload": "w", "profiler": "p", "environment": {}},
    ),
    (
        "POST",
        "/performance/comparisons",
        "/performance/comparisons",
        {
            "repository": "r",
            "workload": "w",
            "baselineRevision": "a",
            "candidateRevision": "b",
            "environment": {},
        },
    ),
    (
        "GET",
        "/performance/records/{record_id}",
        "/performance/records/measurement_missing",
        None,
    ),
    ("GET", "/performance/regressions", "/performance/regressions", None),
    ("POST", "/objectives", "/objectives", {"repo": "r", "type": "explore", "title": "t"}),
    ("GET", "/objectives", "/objectives", None),
    ("POST", "/runs", "/runs", {"objective_id": "obj_x", "agent": "explore"}),
    ("GET", "/runs/{run_id}", "/runs/run_x", None),
    ("GET", "/runs/{run_id}/logs", "/runs/run_x/logs", None),
    (
        "POST",
        "/optimize",
        "/optimize",
        OPTIMIZE_BODY,
    ),
    (
        "POST",
        "/promotions/{promotion_id}/approve",
        "/promotions/prom_x/approve",
        {"approved_by": "human", "comment": "looks good"},
    ),
    (
        "POST",
        "/promotions/{promotion_id}/reject",
        "/promotions/prom_x/reject",
        {"approved_by": "human", "comment": "too risky"},
    ),
    ("GET", "/promotions/pending", "/promotions/pending", None),
    (
        "POST",
        "/experiments",
        "/experiments",
        {
            "apiVersion": "bakudo.ai/v1alpha1",
            "kind": "ExperimentSpec",
            "metadata": {"name": "t"},
            "subject": {"kind": "agent-spec", "baseline": "explore@1"},
        },
    ),
    ("GET", "/experiments/{experiment_id}", "/experiments/exp_x", None),
    ("GET", "/trials/{trial_id}", "/trials/trial_x", None),
    ("POST", "/repos", "/repos", {"source": "/nonexistent/repo/path"}),
    ("GET", "/repos", "/repos", None),
    ("GET", "/status", "/status", None),
    # Schema/docs routes: mounted as real path operations so they obey the
    # same bearer policy as everything else (schema-only exposure is still
    # exposure).
    ("GET", "/openapi.json", "/openapi.json", None),
    ("GET", "/docs", "/docs", None),
    ("GET", "/redoc", "/redoc", None),
]

ROUTE_IDS = [f"{m} {t}" for m, t, _, _ in ROUTES]


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    """Every test states its auth/sandbox posture explicitly."""
    for var in ("BAKUDO_API_TOKEN", "BAKUDO_SANDBOX", "BAKUDO_ENV"):
        monkeypatch.delenv(var, raising=False)


def _dev_local_sandbox(monkeypatch):
    monkeypatch.setenv("BAKUDO_SANDBOX", "local")
    monkeypatch.setenv("BAKUDO_ENV", "dev")
    monkeypatch.setenv("BAKUDO_OFFLINE", "1")


# --- API-1 / API-10: every route requires the bearer token when configured ---


def test_auth_matrix_covers_every_route():
    """Self-checking: EVERY route on the app — schema/docs included, no
    carve-outs — must appear in ROUTES, so a new route (or a FastAPI default
    route reappearing outside the auth dependency) fails this test instead of
    silently escaping the sweep."""
    app = build_app()
    app_routes = {
        (method, route.path)
        for route in app.routes
        for method in getattr(route, "methods", set())
        if method != "HEAD"
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


# --- PR#48 review: coherent posture for the schema/docs routes ---
#
# Posture: /openapi.json, /docs and /redoc obey the bearer policy like every
# other route (the matrix above enforces it). Auth is a DECLARED HTTPBearer
# security scheme, so the schema documents the auth model and Swagger UI has
# an Authorize button for try-it-out. Interactive docs are fully usable in
# tokenless dev mode; in token-secured deployments the docs pages (like the
# schema) require the header — reachable via curl/codegen with the token or
# behind a header-injecting proxy, which injects on the page load AND on
# Swagger UI's /openapi.json XHR alike.


def test_openapi_declares_bearer_security_scheme():
    schema = TestClient(build_app()).get("/openapi.json").json()
    schemes = schema.get("components", {}).get("securitySchemes", {})
    assert any(s.get("type") == "http" and s.get("scheme") == "bearer" for s in schemes.values()), (
        f"no HTTP bearer security scheme declared: {schemes}"
    )
    (scheme_name,) = [
        name
        for name, s in schemes.items()
        if s.get("type") == "http" and s.get("scheme") == "bearer"
    ]
    for path, operations in schema["paths"].items():
        for method, operation in operations.items():
            assert {scheme_name: []} in operation.get("security", []), (
                f"{method.upper()} {path} does not declare the bearer scheme"
            )


def test_docs_fully_usable_in_tokenless_dev_mode():
    client = TestClient(build_app())
    docs = client.get("/docs")
    assert docs.status_code == 200
    assert "swagger-ui" in docs.text
    redoc = client.get("/redoc")
    assert redoc.status_code == 200
    assert "redoc" in redoc.text
    assert client.get("/openapi.json").status_code == 200


def test_docs_and_schema_load_with_the_bearer_header(monkeypatch):
    """A header-injecting client (curl, proxy) gets the docs page AND the
    schema it fetches — the pair works, or 401s, together."""
    monkeypatch.setenv("BAKUDO_API_TOKEN", TOKEN)
    client = TestClient(build_app())
    assert client.get("/docs", headers=AUTH).status_code == 200
    assert client.get("/openapi.json", headers=AUTH).status_code == 200
    assert client.get("/docs").status_code == 401
    assert client.get("/openapi.json").status_code == 401


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
    resp = client.post("/optimize", json=OPTIMIZE_BODY)
    assert resp.status_code == 409
    assert "BAKUDO_SANDBOX" in resp.json()["detail"]


def test_optimize_409_when_local_sandbox_outside_dev(monkeypatch):
    monkeypatch.setenv("BAKUDO_SANDBOX", "local")
    client = TestClient(build_app())
    resp = client.post("/optimize", json=OPTIMIZE_BODY)
    assert resp.status_code == 409
    assert "BAKUDO_ENV" in resp.json()["detail"]


def test_optimize_409_on_unknown_sandbox_value(monkeypatch):
    monkeypatch.setenv("BAKUDO_SANDBOX", "bogus")
    client = TestClient(build_app())
    assert client.post("/optimize", json=OPTIMIZE_BODY).status_code == 409


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


_EXPERIMENT_BODY = {
    "apiVersion": "bakudo.ai/v1alpha1",
    "kind": "ExperimentSpec",
    "metadata": {"name": "t"},
    "subject": {"kind": "agent-spec", "baseline": "explore@1"},
}


def test_experiments_409_when_sandbox_unset():
    client = TestClient(build_app())
    resp = client.post("/experiments", json=_EXPERIMENT_BODY)
    assert resp.status_code == 409
    assert "BAKUDO_SANDBOX" in resp.json()["detail"]


def test_experiments_409_when_dev_env_unset(monkeypatch):
    """R2: verifier-test grading always executes on this host via the local
    test runner, independent of the sandbox mode driving the agent -- so
    this 409 fires even once the sandbox itself resolves fine."""
    monkeypatch.setattr("bakudo.api.server._resolve_sandbox", lambda: lambda bundle: None)
    client = TestClient(build_app())
    resp = client.post("/experiments", json=_EXPERIMENT_BODY)
    assert resp.status_code == 409
    assert "BAKUDO_ENV" in resp.json()["detail"]


def test_experiments_422_on_invalid_spec(monkeypatch):
    _dev_local_sandbox(monkeypatch)
    client = TestClient(build_app())
    bad = {**_EXPERIMENT_BODY, "subject": {"kind": "not-agent-spec"}}
    resp = client.post("/experiments", json=bad)
    assert resp.status_code == 422


def test_experiments_post_get_round_trip(monkeypatch):
    from bakudo.control import MetaAgentTools

    _dev_local_sandbox(monkeypatch)
    tools = MetaAgentTools()
    client = TestClient(build_app(tools))
    # count=1 selects one primary task; paired-task closure deliberately adds
    # its counterpart so joint no-change/fix behavior remains measurable.
    body = {
        **_EXPERIMENT_BODY,
        "subject": {
            **_EXPERIMENT_BODY["subject"],
            "taskSelector": {"count": 1},
        },
    }
    resp = client.post("/experiments", json=body)
    assert resp.status_code == 200, resp.text
    experiment_id = resp.json()["id"]
    assert experiment_id.startswith("exp_")

    got = client.get(f"/experiments/{experiment_id}")
    assert got.status_code == 200
    got_body = got.json()
    assert got_body["status"] == "completed"
    assert got_body["result"]["experimentId"] == experiment_id
    assert got_body["result"]["profile"] is True

    trials = tools.ledger.list_trials(experiment_id)
    assert len(trials) == 2
    trial = trials[0]
    trial_resp = client.get(f"/trials/{trial.id}")
    assert trial_resp.status_code == 200
    assert trial_resp.json()["experiment_id"] == experiment_id


def test_get_experiment_unknown_is_404():
    client = TestClient(build_app())
    assert client.get("/experiments/exp_missing").status_code == 404


def test_get_trial_unknown_is_404():
    client = TestClient(build_app())
    assert client.get("/trials/trial_missing").status_code == 404


def test_optimize_threads_resolved_sandbox_into_loop(monkeypatch):
    _dev_local_sandbox(monkeypatch)
    captured: dict = {}

    def comparison(diff):
        return None

    def fake_loop(objective, scout_spec, attempt_spec, **kwargs):
        captured["objective"] = objective
        captured["kwargs"] = kwargs
        return {"status": "no-change", "rounds_used": 1, "reason": "stub"}

    monkeypatch.setattr("bakudo.control.optimize.run_optimize_loop", fake_loop)
    monkeypatch.setattr(
        "bakudo.api.server._build_optimize_performance_compare",
        lambda objective, ledger, seed: comparison,
    )
    client = TestClient(build_app())
    resp = client.post(
        "/optimize",
        json={
            "repo": "payments-api",
            "title": "Optimize dedup",
            "performance": {
                "workloadRef": {
                    "name": "smoke-python-loop",
                    "version": "1.0.0",
                    "source": "directory",
                },
                "primaryMetric": "latency_seconds",
            },
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
    assert objective.performance.workload_ref.name == "smoke-python-loop"
    assert objective.performance.primary_metric == "latency_seconds"
    assert objective.constraints.target_paths == ["src/ledger/**"]
    assert captured["kwargs"]["max_rounds"] == 4
    assert captured["kwargs"]["performance_compare"] is comparison


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
        query_params = {p["name"] for p in post.get("parameters", []) if p.get("in") == "query"}
        assert not query_params.intersection(fields), (
            f"{path} binds {query_params & set(fields)} as query params"
        )


def test_build_app_boots_when_seed_agents_are_missing(monkeypatch, caplog):
    """PR#48 review: an install with no bundled agents data (stripped wheel,
    src-only image) must boot degraded — seed registration is skipped with a
    warning, and seed-agent-by-name is a 404, never a startup crash."""

    def _no_agents():
        raise FileNotFoundError("no bundled agents anywhere")

    monkeypatch.setattr("bakudo.paths.agents_dir", _no_agents)
    _dev_local_sandbox(monkeypatch)
    with caplog.at_level(logging.WARNING, logger="bakudo.api.server"):
        client = TestClient(build_app())  # must not raise
    assert any("seed agents" in r.getMessage() for r in caplog.records)
    obj = client.post("/objectives", json={"repo": "r", "type": "explore", "title": "t"})
    assert obj.status_code == 200
    resp = client.post("/runs", json={"objective_id": obj.json()["id"], "agent": "explore"})
    assert resp.status_code == 404


# --- API-9: invalid inputs are 422, not 500 ---


def test_bad_queue_value_is_422():
    client = TestClient(build_app())
    resp = client.get("/objectives", params={"queue": "bogus"})
    assert resp.status_code == 422
    detail = resp.json()["detail"]
    assert "bogus" in detail
    assert "ready" in detail  # names the valid queues


def test_invalid_objective_payload_is_422():
    client = TestClient(build_app())
    resp = client.post("/objectives", json={"repo": "r", "type": "not-a-type", "title": "t"})
    assert resp.status_code == 422


# --- spec §25.3 / OPT-7/API-7: promotions resolve from the ledger, not the body ---


def _tools_with_pending_promotion():
    """A tools instance whose ledger holds a pending_human candidate."""
    from bakudo.control import MetaAgentTools
    from bakudo.evals.promotion import apply_decision, decide
    from bakudo.evals.scorecard import Scorecard
    from bakudo.registry.records import AgentVersionRecord

    tools = MetaAgentTools()
    for version, status in ((1, "active"), (2, "candidate")):
        tools.ledger.upsert_agent_version(
            AgentVersionRecord(
                name="add-feature",
                version=version,
                status=status,
                spec_yaml=f"metadata:\n  name: add-feature\n  version: {version}\n",
            )
        )

    def card(score, subject_id):
        return Scorecard(
            subject_type="agent_spec_version",
            subject_id=subject_id,
            overall_score=score,
            cases_total=30,
            suites={
                "schema": score,
                "safety": score,
                "regression": score,
                "role-specific": score,
                "code": score,
            },
            passed_suites=["schema", "safety", "regression", "role-specific", "code"],
        )

    decision = decide(
        card(0.9, "add-feature@2"),
        card(0.5, "add-feature@1"),
        mutation_kinds=["new-secret-access"],
    )
    apply_decision(tools.ledger, decision)
    return tools, decision


def test_pending_promotions_come_from_the_ledger():
    tools, decision = _tools_with_pending_promotion()
    client = TestClient(build_app(tools))
    pending = client.get("/promotions/pending").json()
    assert [p["id"] for p in pending] == [decision.id]
    assert pending[0]["status"] == "pending"
    assert pending[0]["gated_mutations"] == ["new-secret-access"]


def test_approve_promotion_transitions_candidate_to_canary():
    tools, decision = _tools_with_pending_promotion()
    client = TestClient(build_app(tools))
    resp = client.post(
        f"/promotions/{decision.id}/approve",
        json={"approved_by": "al", "comment": "evals look good"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "approved"
    assert body["approved_by"] == "al"
    # The scorecard in the response is the LEDGER's, not caller-supplied.
    assert body["scorecard"]["subject_id"] == "add-feature@2"
    assert tools.ledger.get_agent_version("add-feature", 2).status == "canary"
    assert client.get("/promotions/pending").json() == []


def test_reject_promotion_transitions_candidate_to_rejected():
    tools, decision = _tools_with_pending_promotion()
    client = TestClient(build_app(tools))
    resp = client.post(
        f"/promotions/{decision.id}/reject",
        json={"approved_by": "al", "comment": "too risky"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "rejected"
    assert tools.ledger.get_agent_version("add-feature", 2).status == "rejected"


def test_approve_promotion_ignores_caller_scorecards_and_mutations():
    """OPT-7: fabricated scorecards/mutation_kinds in the body must not be
    trusted — the ledger's stored decision is authoritative."""
    tools, decision = _tools_with_pending_promotion()
    client = TestClient(build_app(tools))
    resp = client.post(
        f"/promotions/{decision.id}/approve",
        json={
            "approved_by": "al",
            "comment": "ok",
            "scorecard": {"overall_score": 1.0, "subject_id": "forged@9"},
            "mutation_kinds": [],
        },
    )
    assert resp.status_code == 200
    assert resp.json()["scorecard"]["subject_id"] == "add-feature@2"
    assert resp.json()["gated_mutations"] == ["new-secret-access"]


def test_approve_unknown_promotion_is_404():
    client = TestClient(build_app())
    resp = client.post("/promotions/prom_missing/approve", json={"approved_by": "al"})
    assert resp.status_code == 404


def test_approve_twice_is_409():
    tools, decision = _tools_with_pending_promotion()
    client = TestClient(build_app(tools))
    first = client.post(f"/promotions/{decision.id}/approve", json={"approved_by": "al"})
    assert first.status_code == 200
    second = client.post(f"/promotions/{decision.id}/reject", json={"approved_by": "al"})
    assert second.status_code == 409


def test_old_bulk_approve_route_is_gone():
    """The caller-supplied-scorecard route is REMOVED outright (approved
    decision, no shim)."""
    client = TestClient(build_app())
    resp = client.post(
        "/promotions/approve",
        json={"candidate": {"subject_type": "run", "subject_id": "r1", "overall_score": 0.9}},
    )
    # /promotions/approve now only matches /promotions/{promotion_id}/... shapes.
    assert resp.status_code in (404, 405)


# --- reads still work with auth disabled ---


def test_read_routes_open_and_pending_promotions_empty():
    client = TestClient(build_app())
    assert client.get("/status").status_code == 200
    assert client.get("/promotions/pending").json() == []


# --- POST/GET /repos (repo onboarding, P2 Task 1) ---


def _init_git_repo(path):
    import subprocess

    path.mkdir(parents=True, exist_ok=True)
    subprocess.run(["git", "init", "-q", "-b", "main", str(path)], check=True)
    subprocess.run(["git", "-C", str(path), "config", "user.email", "t@t"], check=True)
    subprocess.run(["git", "-C", str(path), "config", "user.name", "t"], check=True)
    subprocess.run(["git", "-C", str(path), "config", "commit.gpgsign", "false"], check=True)
    (path / "README.md").write_text("hi\n")
    subprocess.run(["git", "-C", str(path), "add", "-A"], check=True)
    subprocess.run(["git", "-C", str(path), "commit", "-q", "-m", "init"], check=True)
    return path


def test_post_repos_registers_local_checkout_then_get_lists_it(tmp_path):
    repo = _init_git_repo(tmp_path / "myrepo")
    client = TestClient(build_app())

    resp = client.post("/repos", json={"source": str(repo)})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["name"] == "myrepo"
    assert body["path"] == str(repo.resolve())

    listed = client.get("/repos").json()
    assert [r["name"] for r in listed] == ["myrepo"]


def test_post_repos_conflicting_path_for_same_name_is_409(tmp_path):
    repo_a = _init_git_repo(tmp_path / "a")
    repo_b = _init_git_repo(tmp_path / "b")
    client = TestClient(build_app())

    assert client.post("/repos", json={"source": str(repo_a), "name": "dup"}).status_code == 200
    resp = client.post("/repos", json={"source": str(repo_b), "name": "dup"})
    assert resp.status_code == 409


def test_post_repos_target_already_exists_is_409(tmp_path, monkeypatch):
    """Code review finding 4: the pre-clone existing-target-dir branch."""
    source = _init_git_repo(tmp_path / "source-repo")
    dest_root = tmp_path / "checkouts"
    (dest_root / "source-repo").mkdir(parents=True)
    monkeypatch.setenv("BAKUDO_REPO_ROOT", str(dest_root))

    client = TestClient(build_app())
    resp = client.post("/repos", json={"source": f"file://{source}"})
    assert resp.status_code == 409
    assert "already exists" in resp.json()["detail"]


def test_post_repos_missing_local_path_is_404(tmp_path):
    client = TestClient(build_app())
    resp = client.post("/repos", json={"source": str(tmp_path / "does-not-exist")})
    assert resp.status_code == 404


def test_post_repos_url_clones_via_file_scheme(tmp_path, monkeypatch):
    """No network required: git supports file:// clones."""
    source = _init_git_repo(tmp_path / "source-repo")
    dest_root = tmp_path / "checkouts"
    dest_root.mkdir()
    monkeypatch.setenv("BAKUDO_REPO_ROOT", str(dest_root))

    client = TestClient(build_app())
    resp = client.post("/repos", json={"source": f"file://{source}"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["name"] == "source-repo"
    cloned = dest_root / "source-repo"
    assert cloned.is_dir()
    assert (cloned / ".git").is_dir()
