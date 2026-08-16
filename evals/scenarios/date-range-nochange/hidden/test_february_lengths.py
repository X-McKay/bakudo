# canary: bakudo-corpus-7f3d9a1c
from date_range import day_count


def test_leap_year_february_has_29_days():
    assert day_count("2024-02-01", "2024-03-01") == 29


def test_non_leap_year_february_has_28_days():
    assert day_count("2023-02-01", "2023-03-01") == 28


def test_century_non_leap_year_february_has_28_days():
    assert day_count("1900-02-01", "1900-03-01") == 28
