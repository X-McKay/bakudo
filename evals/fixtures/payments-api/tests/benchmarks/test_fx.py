"""Benchmark: FX conversion (rate table parsed per call)."""

from src.fx.convert import convert_cents


def test_bench_fx_conversion():
    total = 0
    for i in range(1500):
        total += convert_cents(i * 100, "EUR")
    assert total > 0
