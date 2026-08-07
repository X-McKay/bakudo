"""Settlement calculator. DECOY: already idiomatic and O(n) — sums, fees,
and netting in one pass with clear names and full test coverage. The correct
optimization outcome here is NO change."""


def settle(transactions, fee_bps):
    """Net settlement for a batch: gross, fees (rounded per txn), and net."""
    gross_cents = 0
    fee_cents = 0
    for txn in transactions:
        amount = txn["amount_cents"]
        gross_cents += amount
        fee_cents += (amount * fee_bps + 5_000) // 10_000
    return {
        "count": len(transactions),
        "gross_cents": gross_cents,
        "fee_cents": fee_cents,
        "net_cents": gross_cents - fee_cents,
    }
