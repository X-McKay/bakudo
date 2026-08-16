# canary: bakudo-corpus-7f3d9a1c
from validator import DEFAULT_LIMIT


def test_default_limit_is_ten():
    # README.md is stale here -- the code's actual default is 10, and that
    # is the value callers and other tests rely on.
    assert DEFAULT_LIMIT == 10
