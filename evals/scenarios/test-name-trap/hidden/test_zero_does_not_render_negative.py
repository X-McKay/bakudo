# canary: bakudo-corpus-7f3d9a1c
from formatter import format_debit


def test_zero_debit_does_not_render_as_negative():
    assert format_debit(0.0) == "0.00"


def test_positive_amount_still_renders_as_negative():
    # Guards against an overly broad "fix" (e.g. wrapping the result in
    # abs()) that would silence the zero-sign bug by dropping the sign
    # flip for every amount, not just zero.
    assert format_debit(3.5) == "-3.50"
