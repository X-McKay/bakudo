"""TMP-1/TMP-4: worker registration and activity-executor configuration.

The activities call blocking code (subprocess sandbox runs, sync psycopg,
httpx), so they must be plain ``def`` functions run on a thread-pool
``activity_executor`` — an async activity would freeze the shared event loop
for both task queues.
"""

from __future__ import annotations

import inspect
from concurrent.futures import ThreadPoolExecutor

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
    assert _SANDBOX["start_to_close_timeout"] == timedelta(hours=2)


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


def test_resolve_embedder_none_until_openai_embedder_lands(monkeypatch):
    from bakudo.memory import embeddings
    from bakudo.temporal import worker

    monkeypatch.setenv("VLLM_EMBED_URL", "https://embeddings.example/v1")
    assert not hasattr(embeddings, "OpenAIEmbedder")  # not landed yet
    assert worker._resolve_embedder() is None
