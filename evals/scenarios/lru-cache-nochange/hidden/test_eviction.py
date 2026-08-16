# canary: bakudo-corpus-7f3d9a1c
import pytest

from lru_cache import LRUCache


def test_eviction_removes_oldest_not_newest():
    cache = LRUCache(2)
    cache.put("a", 1)
    cache.put("b", 2)
    cache.put("c", 3)  # over capacity: "a" is oldest and should be evicted

    assert cache.get("c") == 3
    assert cache.get("b") == 2
    with pytest.raises(KeyError):
        cache.get("a")
