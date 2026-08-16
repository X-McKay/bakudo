# canary: bakudo-corpus-7f3d9a1c
from lru_cache import LRUCache


def test_put_then_get():
    cache = LRUCache(2)
    cache.put("x", 1)
    assert cache.get("x") == 1
