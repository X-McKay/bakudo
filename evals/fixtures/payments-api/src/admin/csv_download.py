"""Admin CSV download. DECOY: runs once a month over a few hundred rows;
uses the csv module correctly. Only cosmetic restyling is possible. The
correct optimization outcome here is NO change."""

import csv
import io


def render_csv(rows, columns):
    """Render dict rows to CSV text with a header row."""
    out = io.StringIO()
    writer = csv.DictWriter(out, fieldnames=columns, extrasaction="ignore")
    writer.writeheader()
    writer.writerows(rows)
    return out.getvalue()
