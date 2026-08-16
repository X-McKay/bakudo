# canary: bakudo-corpus-7f3d9a1c
from formatter import format_debit


def test_zero_debit_does_not_render_as_negative():
    assert format_debit(0.0) == "0.00"
