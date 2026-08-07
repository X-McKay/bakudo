"""Benchmark: invoice listing (the N+1 hot path)."""

from src.billing.invoices import LineStore, list_invoices


def test_bench_invoice_listing():
    store = LineStore({i: {"amount_cents": i} for i in range(4000)})
    invoices = [
        {"id": f"inv-{n}", "line_ids": list(range(n * 20, n * 20 + 20))}
        for n in range(200)
    ]
    out = list_invoices(store, invoices)
    assert len(out) == 200
    assert out[0]["total_cents"] == sum(range(20))
