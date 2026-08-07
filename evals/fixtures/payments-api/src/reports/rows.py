"""Report rows. PLANTED: manual dict assembly, key by key, where a dict
literal (or comprehension) says the same thing in a third of the lines."""


def build_row(payment):
    row = {}
    row["id"] = payment["id"]
    row["account"] = payment["account"]
    row["amount_cents"] = payment["amount_cents"]
    row["currency"] = payment["currency"]
    row["status"] = payment["status"]
    row["fee_cents"] = payment.get("fee_cents", 0)
    row["net_cents"] = payment["amount_cents"] - payment.get("fee_cents", 0)
    row["settled"] = payment["status"] == "settled"
    return row


def build_rows(payments):
    rows = []
    for payment in payments:
        rows.append(build_row(payment))
    return rows
