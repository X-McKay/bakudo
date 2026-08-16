# canary: bakudo-corpus-7f3d9a1c
from ranges import format_range


def test_range_starts_with_the_low_endpoint():
    assert format_range(4, 9).startswith("4-")
