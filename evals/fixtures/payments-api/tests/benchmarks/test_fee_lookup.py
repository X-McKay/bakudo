"""Benchmark: fee lookup (re-sorts the tier table per request)."""

from src.fees.schedule import fee_bps_for


def test_bench_fee_lookup():
    total = 0
    for i in range(4000):
        total += fee_bps_for(i * 331)
    assert total > 0
