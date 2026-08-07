"""Fee schedule lookup. PLANTED: the fee table is re-sorted on every lookup;
sort once at module load (or bisect over a pre-sorted table)."""

FEE_TIERS = [
    {"min_cents": 5_000_000, "fee_bps": 8},
    {"min_cents": 0, "fee_bps": 45},
    {"min_cents": 1_000_000, "fee_bps": 15},
    {"min_cents": 100_000, "fee_bps": 25},
    {"min_cents": 10_000, "fee_bps": 35},
] * 40  # the production table has ~200 rows


def fee_bps_for(amount_cents):
    """The basis-point fee for an amount: highest tier at or below it wins."""
    tiers = sorted(FEE_TIERS, key=lambda tier: tier["min_cents"], reverse=True)
    for tier in tiers:
        if amount_cents >= tier["min_cents"]:
            return tier["fee_bps"]
    return tiers[-1]["fee_bps"]
