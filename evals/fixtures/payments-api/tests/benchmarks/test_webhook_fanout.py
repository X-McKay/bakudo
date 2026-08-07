"""Benchmark: webhook fan-out (per-event connection setup)."""

from src.webhooks.dispatch import Transport, fan_out


def test_bench_webhook_fanout():
    transport = Transport()
    events = [
        {"id": i, "endpoint": f"https://hooks.example/{i % 3}"} for i in range(400)
    ]
    assert fan_out(transport, events) == 400
    assert len(transport.sent) == 400
