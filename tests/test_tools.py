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
        {"id": "obj_01HZZZZZZZZZZZZZZZZZZZZZZ0", "type": "explore",
         "repo": "bakudo", "title": "map", "priority": {"value": 0.9}}
    )
    listed = tools.list_objectives()
    assert listed[0]["id"] == oid


def test_spawn_run_and_query(tools):
    oid = tools.create_objective(
        {"id": "obj_01HZZZZZZZZZZZZZZZZZZZZZZ1", "type": "explore",
         "repo": "bakudo", "title": "map it"}
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
