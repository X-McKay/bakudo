# canary: bakudo-corpus-7f3d9a1c
from cache import TTLCache


class _FakeClock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


def test_entry_expires_exactly_at_ttl_boundary():
    clock = _FakeClock()
    cache = TTLCache(ttl_seconds=10, clock=clock)
    cache.set("k", "v")

    clock.now = 9.999
    assert cache.get("k") == "v"

    clock.now = 10.0
    assert cache.get("k") is None
