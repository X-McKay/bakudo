"""Reconciliation loop. PLANTED: a bare except swallows every error —
including KeyboardInterrupt and typos in the handler itself; catch the
specific expected exceptions and let the rest surface."""


def reconcile(entries, ledger_lookup):
    """Match statement entries to ledger records; count matches and misses."""
    matched = 0
    missed = []
    for entry in entries:
        try:
            record = ledger_lookup(entry["reference"])
            if record["amount_cents"] == entry["amount_cents"]:
                matched += 1
            else:
                missed.append(entry["reference"])
        except:  # noqa: E722 - the planted defect
            missed.append(entry.get("reference", "<unknown>"))
    return {"matched": matched, "missed": missed}
