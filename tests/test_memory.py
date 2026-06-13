import pytest

from bakudo.memory import InMemoryStore, MemoryItem, MemoryRejected, validate_memory_candidate


def _mem(**kw):
    base = dict(
        type="repo_fact",
        content="Webhook retries live in src/webhooks/retry.py.",
        scope={"repo": "payments-api"},
        evidence=[{"path": "src/webhooks/retry.py", "run_id": "run_X"}],
        confidence=0.9,
    )
    base.update(kw)
    return MemoryItem.model_validate(base)


def test_valid_memory_is_accepted():
    assert validate_memory_candidate(_mem()) == []
    InMemoryStore().write_candidate(_mem())


def test_rejects_missing_evidence():
    reasons = validate_memory_candidate(_mem(evidence=[]))
    assert "lacks evidence" in reasons


def test_rejects_low_confidence():
    reasons = validate_memory_candidate(_mem(confidence=0.1))
    assert any("confidence" in r for r in reasons)


def test_rejects_no_scope():
    reasons = validate_memory_candidate(_mem(scope={}))
    assert any("scoped" in r for r in reasons)


def test_rejects_secret_content():
    reasons = validate_memory_candidate(
        _mem(content="the api_key = sk-abcdefghijklmnopqrstuvwxyz123456")
    )
    assert "contains a secret" in reasons


def test_store_raises_on_rejection():
    store = InMemoryStore()
    with pytest.raises(MemoryRejected):
        store.write_candidate(_mem(evidence=[]))


def test_query_filters_by_scope_and_orders_by_confidence():
    store = InMemoryStore()
    store.write_candidate(_mem(content="fact about A repo here", confidence=0.7))
    store.write_candidate(_mem(content="another fact about A repo", confidence=0.95))
    results = store.query(scope={"repo": "payments-api"})
    assert results[0].confidence == 0.95
