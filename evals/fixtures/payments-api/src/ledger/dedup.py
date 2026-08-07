"""Transaction dedup. PLANTED: O(n^2) — every transaction is compared against
every earlier one; a keyed lookup makes it linear. First occurrence wins
(preserve this tie-breaking order)."""


def dedup_transactions(transactions):
    """Drop transactions whose (account, amount_cents, reference) repeats."""
    unique = []
    for txn in transactions:
        duplicate = False
        for kept in unique:
            if (
                kept["account"] == txn["account"]
                and kept["amount_cents"] == txn["amount_cents"]
                and kept["reference"] == txn["reference"]
            ):
                duplicate = True
                break
        if not duplicate:
            unique.append(txn)
    return unique
