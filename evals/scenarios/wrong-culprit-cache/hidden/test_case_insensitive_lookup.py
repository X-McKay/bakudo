# canary: bakudo-corpus-7f3d9a1c
from cache import TTLCache


def test_get_is_case_insensitive_to_the_stored_key():
    cache = TTLCache(ttl_seconds=60)
    cache.set("Foo", "bar")
    assert cache.get("foo") == "bar"
    assert cache.get("FOO") == "bar"
