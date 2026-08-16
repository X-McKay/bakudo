# canary: bakudo-corpus-7f3d9a1c
from lru_cache import LRUCache


def test_put_get_roundtrip():
    cache = LRUCache(3)
    cache.put("k", "v")
    assert cache.get("k") == "v"
