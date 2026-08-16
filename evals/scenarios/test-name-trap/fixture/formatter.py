# canary: bakudo-corpus-7f3d9a1c
"""Format debit amounts (money leaving an account) for statements."""

from __future__ import annotations


def format_debit(amount: float) -> str:
    """Format `amount` (a signed quantity) as a statement-style debit
    string with 2 decimal places, e.g. format_debit(3.5) == "-3.50".

    A debit of exactly zero should show as "0.00", never "-0.00".
    """
    # BUG: negating exactly 0.0 produces the float -0.0, and Python's
    # string formatting of -0.0 keeps the sign, printing "-0.00" for an
    # amount that should read as plain zero.
    return f"{-amount:.2f}"
