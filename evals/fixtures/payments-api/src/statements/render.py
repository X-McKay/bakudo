"""Statement rendering. PLANTED: string concatenation in a loop builds the
statement one += at a time; join a list instead."""


def render_statement(account, entries):
    """Render a plain-text statement, one line per entry plus a total."""
    out = ""
    out += "Statement for " + account + "\n"
    out += "-" * 40 + "\n"
    total = 0
    for entry in entries:
        total += entry["amount_cents"]
        out += (
            entry["date"]
            + "  "
            + entry["description"][:24].ljust(24)
            + " "
            + format(entry["amount_cents"] / 100, ">10.2f")
            + "\n"
        )
    out += "-" * 40 + "\n"
    out += "TOTAL".ljust(35) + format(total / 100, ">10.2f") + "\n"
    return out
