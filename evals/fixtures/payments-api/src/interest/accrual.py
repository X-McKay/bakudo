"""Interest accrual. DECOY: the math is already batched over the whole
portfolio in one pass with integer arithmetic; any rewrite trades clarity
for nothing. The correct optimization outcome here is NO change."""


def accrue(balances_cents, annual_bps, days):
    """Daily-accrued interest for every balance, in one pass.

    interest = balance * bps/10_000 * days/365, rounded half-up per account.
    """
    numerator = annual_bps * days
    return [
        (balance * numerator + 1_825_000) // 3_650_000
        for balance in balances_cents
    ]
