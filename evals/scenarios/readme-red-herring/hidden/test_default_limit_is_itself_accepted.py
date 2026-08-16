# canary: bakudo-corpus-7f3d9a1c
from validator import DEFAULT_LIMIT, validate_limit


def test_default_limit_is_itself_accepted():
    assert validate_limit(DEFAULT_LIMIT) == DEFAULT_LIMIT
