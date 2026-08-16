# canary: bakudo-corpus-7f3d9a1c
from validator import validate_limit


def test_small_limit_is_accepted():
    assert validate_limit(1) == 1
