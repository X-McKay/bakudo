"""Benchmark: statement rendering (string concatenation in a loop)."""

from src.statements.render import render_statement


def test_bench_statement_render():
    entries = [
        {"date": "2026-01-01", "description": f"txn {i}", "amount_cents": i}
        for i in range(4000)
    ]
    text = render_statement("acct-bench", entries)
    assert text.count("\n") == 4000 + 4
