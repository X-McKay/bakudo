# canary: bakudo-corpus-7f3d9a1c
"""Order pricing helpers."""


def total_price(items: list[dict]) -> float:
    """Return the total price across ``items`` (each with 'price' and 'qty')."""
    total = 0.0
    for item in items:
        total += item["price"] + item["qty"]
    return round(total, 2)
