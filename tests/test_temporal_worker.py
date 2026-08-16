"""TMP-1/TMP-4: worker registration and activity-executor configuration.

The activities call blocking code (subprocess sandbox runs, sync psycopg,
httpx), so they must be plain ``def`` functions run on a thread-pool
``activity_executor`` — an async activity would freeze the shared event loop
for both task queues.
"""

from __future__ import annotations

import inspect
import logging
from concurrent.futures import ThreadPoolExecutor

import pytest

from bakudo.temporal.activities import ALL_ACTIVITIES
from bakudo.temporal.shared import TASK_QUEUE_CONTROL, TASK_QUEUE_RUNS


def test_all_activities_are_sync():
    """Async activities on a shared event loop block both task queues (TMP-1)."""
    offenders = [fn.__name__ for fn in ALL_ACTIVITIES if inspect.iscoroutinefunction(fn)]
    assert offenders == [], f"activities must be sync def: {offenders}"


def test_control_queue_registers_every_control_plane_workflow():
    """TMP-4: unregistered workflow types hang with 'workflow type not
    registered' — evolution/compaction/observer must be on the control queue."""
    from bakudo.temporal.worker import worker_configs
    from bakudo.temporal.workflows import (
        AgentEvolutionWorkflow,
        AgentRunWorkflow,
        EvalWorkflow,
        MemoryCompactionWorkflow,
        MetaAgentWorkflow,
        OptimizationWorkflow,
        RepoObserverWorkflow,
    )

    configs = {cfg["task_queue"]: cfg for cfg in worker_configs()}
    control = configs[TASK_QUEUE_CONTROL]["workflows"]
    for wf in (
        MetaAgentWorkflow,
        AgentRunWorkflow,
        EvalWorkflow,
        OptimizationWorkflow,
        AgentEvolutionWorkflow,
        MemoryCompactionWorkflow,
        RepoObserverWorkflow,
    ):
        assert wf in control, f"{wf.__name__} missing from the control queue"

    runs = configs[TASK_QUEUE_RUNS]["workflows"]
    for wf in (AgentRunWorkflow, EvalWorkflow, OptimizationWorkflow):
        assert wf in runs, f"{wf.__name__} missing from the runs queue"


def test_run_sandbox_activity_options_pin_heartbeat_and_single_attempt():
    """TMP-12: run_sandbox must carry a heartbeat_timeout (crash detection in
    minutes, not 2h) and maximum_attempts=1 — a retried sandbox on the same
    run_id/branch is not idempotent."""
    from datetime import timedelta

    from bakudo.temporal.workflows import _SANDBOX

    assert _SANDBOX["retry_policy"].maximum_attempts == 1
    assert _SANDBOX["heartbeat_timeout"] is not None
    assert _SANDBOX["heartbeat_timeout"] <= timedelta(minutes=10)
    # Must exceed the worst-case abox subprocess: the spec-schema cap on
    # timeoutSeconds (10800s) + in-guest setup headroom + host kill headroom.
    from bakudo.abox.runner import (
        IN_GUEST_SETUP_HEADROOM_SECONDS,
        SUBPROCESS_TIMEOUT_HEADROOM_SECONDS,
    )

    worst_case = timedelta(
        seconds=10_800
        + IN_GUEST_SETUP_HEADROOM_SECONDS
        + SUBPROCESS_TIMEOUT_HEADROOM_SECONDS
    )
    assert _SANDBOX["start_to_close_timeout"] >= worst_case


def test_worker_configs_use_thread_pool_executor():
    from bakudo.temporal.worker import worker_configs

    configs = {cfg["task_queue"]: cfg for cfg in worker_configs()}
    assert set(configs) == {TASK_QUEUE_CONTROL, TASK_QUEUE_RUNS}
    for cfg in configs.values():
        assert isinstance(cfg["activity_executor"], ThreadPoolExecutor)
        assert list(cfg["activities"]) == list(ALL_ACTIVITIES)


# --- integration hook: production embedder wiring (memory agent's contract) ---


def test_resolve_embedder_fails_fast_without_vllm_embed_url(monkeypatch):
    """A durable (DSN-backed) memory store must not silently fall back to the
    lexical HashingEmbedder in production."""
    import pytest

    from bakudo.temporal import worker

    monkeypatch.delenv("VLLM_EMBED_URL", raising=False)
    with pytest.raises(RuntimeError, match="VLLM_EMBED_URL"):
        worker._resolve_embedder()


def test_resolve_embedder_constructs_openai_embedder_when_available(monkeypatch):
    from bakudo.memory import embeddings
    from bakudo.temporal import worker

    class FakeOpenAIEmbedder:
        dim = 4

        def __init__(self, base_url):
            self.base_url = base_url

        def embed(self, text):
            return [0.0] * 4

    monkeypatch.setenv("VLLM_EMBED_URL", "https://embeddings.example/v1")
    monkeypatch.setattr(embeddings, "OpenAIEmbedder", FakeOpenAIEmbedder, raising=False)
    emb = worker._resolve_embedder()
    assert isinstance(emb, FakeOpenAIEmbedder)
    assert emb.base_url == "https://embeddings.example/v1"


def test_resolve_graph_returns_none_without_falkordb_url(monkeypatch):
    """The graph mirror is opt-in: no FALKORDB_URL, no graph wiring."""
    from bakudo.temporal import worker

    monkeypatch.delenv("FALKORDB_URL", raising=False)
    assert worker._resolve_graph() is None


def test_resolve_graph_connects_falkordb_with_group_id(monkeypatch):
    """FALKORDB_URL replaces the retired NEO4J_URI/NEO4J_PASSWORD wiring;
    BAKUDO_GRAPH_GROUP_ID namespaces the graph key (MEM-16)."""
    from bakudo.memory import graph as graph_mod
    from bakudo.temporal import worker

    calls = {}

    class FakeGraph:
        pass

    def fake_connect(url, *, group_id="default"):
        calls["url"] = url
        calls["group_id"] = group_id
        return FakeGraph()

    monkeypatch.setenv("FALKORDB_URL", "falkor://falkordb:6379")
    monkeypatch.setenv("BAKUDO_GRAPH_GROUP_ID", "teamA")
    monkeypatch.setattr(graph_mod.FalkorGraphMemory, "connect", staticmethod(fake_connect))

    got = worker._resolve_graph()
    assert isinstance(got, FakeGraph)
    assert calls == {"url": "falkor://falkordb:6379", "group_id": "teamA"}


def test_resolve_graph_defaults_group_id(monkeypatch):
    from bakudo.memory import graph as graph_mod
    from bakudo.temporal import worker

    calls = {}
    monkeypatch.setenv("FALKORDB_URL", "falkor://falkordb:6379")
    monkeypatch.delenv("BAKUDO_GRAPH_GROUP_ID", raising=False)
    monkeypatch.setattr(
        graph_mod.FalkorGraphMemory,
        "connect",
        staticmethod(lambda url, *, group_id="default": calls.setdefault("group_id", group_id)),
    )

    worker._resolve_graph()
    assert calls["group_id"] == "default"


def test_resolve_embedder_builds_real_openai_embedder(monkeypatch):
    """Integration seam: with the real ``OpenAIEmbedder`` landed, the worker
    resolves it from ``VLLM_EMBED_URL`` (construction is lazy — no network
    until the first embed call)."""
    from bakudo.memory import embeddings
    from bakudo.temporal import worker

    monkeypatch.setenv("VLLM_EMBED_URL", "https://embeddings.example/v1")
    emb = worker._resolve_embedder()
    assert isinstance(emb, embeddings.OpenAIEmbedder)
    assert emb._base_url == "https://embeddings.example/v1"

# --- TMP-13: the worker announces its sandbox posture loudly at startup ---
#
# The log exists so `docker compose logs worker` tells the truth about
# whether sandbox runs can work. Each case pins the level (WARNING for any
# doomed/degraded posture, INFO for a working one) and the substrings an
# operator needs to act. The message must agree with what Deps.sandbox_fn
# will actually do at run time.

POSTURE_CASES = [
    pytest.param(
        {"BAKUDO_SANDBOX": "unavailable"},
        None,
        logging.WARNING,
        ["DEGRADED", "/dev/kvm", "BAKUDO_SANDBOX=abox"],
        id="unavailable-degraded",
    ),
    pytest.param(
        {"BAKUDO_SANDBOX": "abox"},
        None,
        logging.WARNING,
        ["abox", "not found"],
        id="abox-binary-missing",
    ),
    pytest.param(
        {"BAKUDO_SANDBOX": "abox"},
        "/usr/local/bin/abox",
        logging.INFO,
        ["abox"],
        id="abox-present",
    ),
    pytest.param(
        {"BAKUDO_SANDBOX": "local", "BAKUDO_ENV": "dev"},
        None,
        logging.INFO,
        ["local"],
        id="local-dev",
    ),
    # PR#48 review: local without BAKUDO_ENV=dev is a doomed posture —
    # sandbox_fn refuses it — and must WARN, not announce a working sandbox.
    pytest.param(
        {"BAKUDO_SANDBOX": "local"},
        None,
        logging.WARNING,
        ["BAKUDO_ENV=dev", "refused"],
        id="local-without-dev-doomed",
    ),
    pytest.param(
        {},
        None,
        logging.WARNING,
        ["BAKUDO_SANDBOX", "not set"],
        id="unset-fail-closed",
    ),
    # PR#48 review: a set-but-unrecognized value must be reported as such
    # (sandbox_fn raises 'Unknown BAKUDO_SANDBOX value'), not as "not set".
    pytest.param(
        {"BAKUDO_SANDBOX": "docker"},
        None,
        logging.WARNING,
        ["'docker'", "nknown"],
        id="unknown-value",
    ),
]


@pytest.mark.parametrize("env,which_result,expected_level,expected_substrings", POSTURE_CASES)
def test_log_sandbox_posture(
    monkeypatch, caplog, env, which_result, expected_level, expected_substrings
):
    from bakudo.temporal import worker

    for var in ("BAKUDO_SANDBOX", "BAKUDO_USE_ABOX", "BAKUDO_ENV"):
        monkeypatch.delenv(var, raising=False)
    for var, value in env.items():
        monkeypatch.setenv(var, value)
    monkeypatch.setattr(worker.shutil, "which", lambda _name: which_result)

    with caplog.at_level(logging.INFO, logger="bakudo.temporal.worker"):
        worker.log_sandbox_posture()

    records = [r for r in caplog.records if "sandbox posture" in r.getMessage()]
    assert len(records) == 1
    assert records[0].levelno == expected_level
    for substring in expected_substrings:
        assert substring in records[0].getMessage()


def test_posture_log_and_runtime_error_share_the_remediation(monkeypatch, caplog):
    """PR#48 review: the startup log and the runtime failure must carry the
    SAME remediation text, sourced from one constant, so they cannot drift."""
    from bakudo.temporal import _impl, worker

    for var in ("BAKUDO_SANDBOX", "BAKUDO_USE_ABOX", "BAKUDO_ENV"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setenv("BAKUDO_SANDBOX", "unavailable")

    with caplog.at_level(logging.WARNING, logger="bakudo.temporal.worker"):
        worker.log_sandbox_posture()
    (record,) = [r for r in caplog.records if "sandbox posture" in r.getMessage()]
    assert _impl.SANDBOX_REMEDIATION in record.getMessage()

    with pytest.raises(RuntimeError) as excinfo:
        _impl.Deps().sandbox_fn()
    assert _impl.SANDBOX_REMEDIATION in str(excinfo.value)
