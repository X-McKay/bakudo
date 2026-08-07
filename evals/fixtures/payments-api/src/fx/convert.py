"""FX conversion. PLANTED: the rate table is parsed from its wire format on
every single conversion; parse once and cache (the table is immutable for
the process lifetime)."""

RATE_TABLE_WIRE = ";".join(
    f"USD:{code}:{1.0 + i / 97:.6f}"
    for i, code in enumerate(
        ["EUR", "GBP", "JPY", "CHF", "AUD", "CAD", "SEK", "NOK", "DKK", "PLN"] * 30
    )
)


def _parse_rates(wire):
    rates = {}
    for entry in wire.split(";"):
        base, quote, rate = entry.split(":")
        rates[(base, quote)] = float(rate)
    return rates


def convert_cents(amount_cents, quote_currency):
    """Convert a USD amount to quote_currency using the wire rate table."""
    rates = _parse_rates(RATE_TABLE_WIRE)
    return int(round(amount_cents * rates[("USD", quote_currency)]))
