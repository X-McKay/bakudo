"""Benchmark: transaction dedup on the large fixture (the O(n^2) hot path)."""

from src.ledger.dedup import dedup_transactions


def test_bench_dedup_large():
    txns = [
        {"account": f"a{i % 400}", "amount_cents": i % 700, "reference": f"r{i % 900}"}
        for i in range(2500)
    ]
    out = dedup_transactions(txns)
    assert 0 < len(out) <= len(txns)
    # Determinism: first occurrence wins.
    assert out[0] == txns[0]
