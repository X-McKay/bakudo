# canary: bakudo-corpus-7f3d9a1c
from formatter import format_debit


def test_negative_amounts_still_format_as_positive():
    assert format_debit(-5) == "5.00"
    assert format_debit(-2.5) == "2.50"
