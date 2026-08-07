"""Invoice listing. PLANTED: N+1 lookups — one db.get_line call per line id
even though the store exposes a batch get_lines; batch it without changing
the response shape."""


class LineStore:
    """The line-item store backing invoice listings."""

    def __init__(self, lines):
        self._lines = dict(lines)
        self.single_gets = 0
        self.batch_gets = 0

    def get_line(self, line_id):
        self.single_gets += 1
        return self._lines[line_id]

    def get_lines(self, line_ids):
        self.batch_gets += 1
        return {line_id: self._lines[line_id] for line_id in line_ids}


def list_invoices(store, invoices):
    """Return [{id, lines, total_cents}] for the given invoices."""
    listed = []
    for invoice in invoices:
        lines = []
        for line_id in invoice["line_ids"]:
            lines.append(store.get_line(line_id))
        listed.append(
            {
                "id": invoice["id"],
                "lines": lines,
                "total_cents": sum(line["amount_cents"] for line in lines),
            }
        )
    return listed
