# canary: bakudo-corpus-7f3d9a1c
from cache import TTLCache


def test_set_then_get_same_key():
    cache = TTLCache(ttl_seconds=60)
    cache.set("x", 1)
    assert cache.get("x") == 1
