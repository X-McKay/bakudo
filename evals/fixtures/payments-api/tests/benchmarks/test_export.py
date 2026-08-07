"""Benchmark: ledger export (open/close per record)."""

from src.export.writer import export_records


def test_bench_export(tmp_path):
    path = tmp_path / "ledger.psv"
    records = [
        {"id": f"r{i}", "account": f"a{i % 10}", "amount_cents": i}
        for i in range(1500)
    ]
    assert export_records(str(path), records) == 1500
    assert len(path.read_text().splitlines()) == 1500
