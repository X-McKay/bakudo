# canary: bakudo-corpus-7f3d9a1c
from formatter import format_debit


def test_handles_negative_numbers():
    # A "negative debit" (e.g. a refund) should display as a positive
    # amount -- and it already does.
    assert format_debit(-5) == "5.00"
