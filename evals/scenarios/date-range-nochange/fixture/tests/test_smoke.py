# canary: bakudo-corpus-7f3d9a1c
from date_range import day_count


def test_single_day_gap():
    assert day_count("2024-06-01", "2024-06-02") == 1
