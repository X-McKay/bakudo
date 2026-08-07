"""Benchmark: reference parsing in the ingest hot path (regex recompiles)."""

from src.ingest.refparse import is_legacy_reference, parse_reference


def test_bench_reference_parsing():
    ok = bad = 0
    for i in range(20_000):
        if parse_reference(f"PAY-2024-{i % 1000:06d}"):
            ok += 1
        if is_legacy_reference(f"Q{i % 100:06d}"):
            bad += 1
    assert ok == 20_000 and bad == 20_000
