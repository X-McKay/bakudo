# canary: bakudo-corpus-7f3d9a1c
from formatter import format_debit


def test_positive_amount_renders_with_a_minus_sign():
    assert format_debit(3.5) == "-3.50"
