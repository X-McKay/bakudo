# canary: bakudo-corpus-7f3d9a1c
from date_range import day_count


def test_same_month_range():
    assert day_count("2024-01-05", "2024-01-20") == 15
