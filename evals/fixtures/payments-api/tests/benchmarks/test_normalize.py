"""Benchmark: event normalisation (deepcopy per event)."""

from src.events.normalize import normalize_batch


def test_bench_normalize():
    payload = {"nested": {"values": list(range(50))}, "tags": ["a"] * 20}
    events = [
        {"type": "charge", "meta": {"i": i}, "payload": payload} for i in range(3000)
    ]
    out = normalize_batch(events)
    assert len(out) == 3000 and out[0]["type"] == "CHARGE"
