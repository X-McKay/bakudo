# canary: bakudo-corpus-7f3d9a1c
from ranges import format_range


def test_range_contains_a_hyphen():
    assert "-" in format_range(1, 2)
