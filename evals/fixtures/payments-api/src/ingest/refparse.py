"""Reference-number parsing. PLANTED: the regexes are recompiled on every
call inside the ingest hot path; hoist compilation to module scope."""

import re


def parse_reference(text):
    """Parse 'PAY-2024-000123' style references -> (kind, year, serial) or None."""
    pattern = re.compile(r"^(PAY|REF|INV)-(\d{4})-(\d{6})$")
    match = pattern.match(text.strip())
    if not match:
        return None
    return match.group(1), int(match.group(2)), int(match.group(3))


def is_legacy_reference(text):
    """Legacy refs look like 'P123456' (single letter + 6 digits)."""
    pattern = re.compile(r"^[A-Z]\d{6}$")
    return bool(pattern.match(text.strip()))
