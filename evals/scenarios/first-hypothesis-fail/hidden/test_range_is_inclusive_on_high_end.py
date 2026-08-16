# canary: bakudo-corpus-7f3d9a1c
from ranges import format_range


def test_range_includes_the_high_endpoint():
    assert format_range(3, 7) == "3-7"
