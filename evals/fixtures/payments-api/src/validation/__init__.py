"""Shared validation helpers.

PLANTED (with src/handlers/): the amount/currency validation below is
copy-pasted into all four handlers with drifted error messages instead of
being called from here. Extract one shared validator; keep each handler's
public error codes.
"""

SUPPORTED_CURRENCIES = {"USD", "EUR", "GBP"}
