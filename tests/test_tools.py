from pathlib import Path

import pytest

from bakudo.agent_spec import load_spec_file
from bakudo.control import MetaAgentTools

AGENTS = Path(__file__).resolve().parents[1] / "agents"


@pytest.fixture
def tools(monkeypatch):
    # Use the built-in offline driver so the default local sandbox needs no model.
    monkeypatch.setenv("BAKUDO_OFFLINE", "1")
    t = MetaAgentTools()
    t.register_agent_spec(load_spec_file(AGENTS / "explore.yaml"))
    return t


def test_create_and_list_objectives(tools):
    oid = tools.create_objective(
        {
            "id": "obj_01HZZZZZZZZZZZZZZZZZZZZZZ0",
            "type": "explore",
            "repo": "bakudo",
            "title": "map",
            "priority": {"value": 0.9},
        }
    )
    listed = tools.list_objectives()
    assert listed[0]["id"] == oid


def test_spawn_run_and_query(tools):
    oid = tools.create_objective(
        {
            "id": "obj_01HZZZZZZZZZZZZZZZZZZZZZZ1",
            "type": "explore",
            "repo": "bakudo",
            "title": "map it",
        }
    )
    run_id = tools.spawn_agent_run(oid, "explore")
    info = tools.query_agent_run(run_id)
    assert info["agent"] == "explore@1"
    assert info["phase"] == "completed"
    # Logs come from the ledger event stream.
    assert any(e["event_type"] == "finished" for e in tools.query_logs(run_id))


def test_meta_agent_has_no_shell_tool(tools):
    # The administrative surface must not expose code execution.
    for forbidden in ("run_command", "shell", "exec", "read_file", "write_file"):
        assert not hasattr(tools, forbidden)


def test_create_candidate_requires_candidate_status(tools):
    spec = load_spec_file(AGENTS / "add-feature.yaml")  # status: active
    with pytest.raises(ValueError):
        tools.create_candidate_agent_spec(spec.to_dict())


def test_write_memory_candidate_rejects_unevidenced(tools):
    out = tools.write_memory_candidate(
        {"type": "repo_fact", "content": "speculation without evidence", "scope": {}}
    )
    assert out["accepted"] is False


# --- OPT-5 / design §2: only active (or routed canary) versions spawn ---


def _version(tools, version, status="candidate"):
    """Register an explore spec version and return its spec object."""
    from bakudo.agent_spec.models import SpecStatus

    base = load_spec_file(AGENTS / "explore.yaml")
    spec = base.model_copy(
        update={
            "metadata": base.metadata.model_copy(
                update={"version": version, "status": SpecStatus.candidate}
            )
        }
    )
    tools.register_agent_spec(spec)
    if status != "candidate":
        tools.ledger.set_version_status("explore", version, status)
    return spec


def test_resolve_spec_returns_active_version_not_latest(tools):
    _version(tools, 2, "candidate")  # a newer candidate must not shadow active
    assert tools._resolve_spec("explore").metadata.version == 1


def test_resolve_spec_ignores_rejected_and_archived_versions(tools):
    _version(tools, 2, "rejected")
    _version(tools, 3, "archived")
    assert tools._resolve_spec("explore").metadata.version == 1


def test_pinned_candidate_version_is_not_spawnable(tools):
    _version(tools, 2, "candidate")
    with pytest.raises(KeyError, match="not spawnable"):
        tools._resolve_spec("explore@2")


def test_pinned_rejected_version_is_not_spawnable(tools):
    _version(tools, 2, "rejected")
    with pytest.raises(KeyError, match="not spawnable"):
        tools._resolve_spec("explore@2")


def test_pinned_archived_version_is_not_spawnable(tools):
    _version(tools, 2, "archived")
    with pytest.raises(KeyError, match="not spawnable"):
        tools._resolve_spec("explore@2")


def test_pinned_active_and_canary_versions_resolve(tools):
    _version(tools, 2, "canary")
    assert tools._resolve_spec("explore@1").metadata.version == 1
    assert tools._resolve_spec("explore@2").metadata.version == 2


def test_canary_routing_is_deterministic_per_run_id(tools):
    """hash(run_id) % 100 < percent routes to the canary (design §2).

    Pinned both ways: sha256('run_CANARYB') % 100 == 3 (< 10 -> canary),
    sha256('run_CANARYA') % 100 == 79 (>= 10 -> active).
    """
    _version(tools, 2, "canary")
    assert tools._resolve_spec("explore", run_id="run_CANARYB").metadata.version == 2
    assert tools._resolve_spec("explore", run_id="run_CANARYA").metadata.version == 1


def test_no_canary_means_every_run_gets_active(tools):
    _version(tools, 2, "candidate")
    assert tools._resolve_spec("explore", run_id="run_CANARYB").metadata.version == 1


def test_resolve_spec_without_active_version_raises(tools):
    tools.ledger.set_version_status("explore", 1, "archived")
    with pytest.raises(KeyError, match="[Nn]o active version"):
        tools._resolve_spec("explore")


def test_spawn_agent_run_records_the_routed_agent_ref(tools):
    _version(tools, 2, "canary")
    oid = tools.create_objective(
        {
            "id": "obj_01HZZZZZZZZZZZZZZZZZZZZZZ2",
            "type": "explore",
            "repo": "bakudo",
            "title": "route me",
        }
    )
    run_id = tools.spawn_agent_run(oid, "explore")
    record = tools.ledger.get_run(run_id)
    from bakudo.evals.promotion import routes_to_canary

    expected = 2 if routes_to_canary(run_id, 10) else 1
    assert record.agent_ref == f"explore@{expected}"
