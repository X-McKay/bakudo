import pytest

from bakudo.memory import HashingEmbedder, MemoryItem, MemoryRejected, SemanticMemoryStore
from bakudo.memory.compaction import compact, memories_from_result
from bakudo.memory.embeddings import cosine
from bakudo.runner.result import RunResult


def _mem(content, conf=0.9):
    return MemoryItem.model_validate({
        "type": "repo_fact", "content": content, "scope": {"repo": "payments-api"},
        "evidence": [{"path": "src/x.py", "run_id": "run_X"}], "confidence": conf,
    })


def test_embedder_similar_texts_are_close():
    e = HashingEmbedder()
    a = e.embed("webhook retry backoff handling")
    b = e.embed("handling webhook retry backoff")
    c = e.embed("unrelated billing invoice totals")
    assert cosine(a, b) > cosine(a, c)


def test_semantic_store_rejects_near_duplicate():
    store = SemanticMemoryStore()
    store.write_candidate(_mem("Webhook retries live in src/webhooks/retry.py.", conf=0.9))
    with pytest.raises(MemoryRejected):
        store.write_candidate(_mem("Webhook retries live in src/webhooks/retry.py.", conf=0.8))


def test_semantic_query_returns_closest():
    store = SemanticMemoryStore()
    store.write_candidate(_mem("Webhook retries live in src/webhooks/retry.py."))
    store.write_candidate(_mem("Billing events are emitted from src/billing/events.py."))
    hits = store.query(text="where is webhook retry logic", limit=1)
    assert hits and "retry.py" in hits[0].content


def test_compaction_writes_evidenced_memories_and_skips_bad_ones():
    result = RunResult.model_validate({
        "run_id": "run_X", "agent": "explore@1", "objective_id": "obj_X",
        "status": "success", "summary": "mapped",
        "memories_to_write": [
            {"type": "repo_fact",
             "content": "Retries are implemented in src/webhooks/retry.py.",
             "evidence": ["src/webhooks/retry.py"], "confidence": 0.9},
            {"type": "repo_fact", "content": "vague", "evidence": [], "confidence": 0.1},
        ],
    })
    store = SemanticMemoryStore()
    report = compact(result, store, repo="payments-api")
    assert len(report.written) == 1
    assert len(report.rejected) == 1


def test_compaction_purges_expired_rows_when_store_supports_it():
    """Compaction is the natural janitor moment: stores exposing
    purge_expired() (the Pg store) get expired rows cleaned up (MEM-5)."""
    result = RunResult.model_validate({
        "run_id": "run_X", "agent": "explore@1", "objective_id": "obj_X",
        "status": "success", "summary": "s", "memories_to_write": [],
    })

    class PurgingStore(SemanticMemoryStore):
        purged = 0

        def purge_expired(self) -> int:
            self.purged += 1
            return 0

    store = PurgingStore()
    compact(result, store, repo="r")
    assert store.purged == 1

    # Stores without purge_expired (the in-memory one) still work.
    compact(result, SemanticMemoryStore(), repo="r")


def test_compaction_drains_the_graph_mirror_outbox_when_supported():
    """Compaction is also the janitor for pending graph-mirror ops (MEM-3):
    stores exposing flush_graph_mirror() (the Pg store) get their backlog
    delivered even if no further writes arrive."""
    result = RunResult.model_validate({
        "run_id": "run_X", "agent": "explore@1", "objective_id": "obj_X",
        "status": "success", "summary": "s", "memories_to_write": [],
    })

    class FlushingStore(SemanticMemoryStore):
        flushed = 0

        def flush_graph_mirror(self) -> int:
            self.flushed += 1
            return 0

    store = FlushingStore()
    compact(result, store, repo="r")
    assert store.flushed == 1


def test_memories_from_result_attaches_run_provenance():
    result = RunResult.model_validate({
        "run_id": "run_42", "agent": "explore@1", "objective_id": "obj_X",
        "status": "success", "summary": "s",
        "memories_to_write": [
            {"type": "repo_fact", "content": "A fact with evidence here.",
             "evidence": ["a.py"], "confidence": 0.8},
        ],
    })
    items = memories_from_result(result, repo="r")
    assert items[0].scope == {"repo": "r"}
    assert any(e.run_id == "run_42" for e in items[0].evidence)
    # MEM-21: the `repo_fact` shorthand is canonicalised onto the stable
    # vocabulary the store/graph index on.
    assert items[0].type == "semantic_memory"


def test_memories_from_result_canonicalises_memory_types():
    from bakudo.memory.models import MemoryType

    assert MemoryType.canonical("repo_fact") == "semantic_memory"
    assert MemoryType.canonical("semantic") == "semantic_memory"
    assert MemoryType.canonical("episodic_memory") == "episodic_memory"
    assert MemoryType.canonical("procedural_memory") == "procedural_memory"
    assert MemoryType.canonical("something-novel") == "semantic_memory"
    assert MemoryType.canonical("") == "semantic_memory"
