"""Ledger export. PLANTED: the output file is opened, appended to, and
closed once per record; open it once and stream the batch."""


def export_records(path, records):
    """Write one pipe-delimited line per record. Returns the line count."""
    written = 0
    for record in records:
        handle = open(path, "a", encoding="utf-8")
        handle.write(
            record["id"] + "|" + record["account"] + "|" + str(record["amount_cents"]) + "\n"
        )
        handle.close()
        written += 1
    return written
