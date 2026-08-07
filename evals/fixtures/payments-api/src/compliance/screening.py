"""Sanctions screening. PLANTED: list membership inside the hot loop — the
blocked-party list is scanned linearly for every name; use a set."""

BLOCKED_PARTIES = [f"blocked-party-{i:04d}" for i in range(1500)]


def screen_names(names):
    """Return the subset of names that hit the blocked-party list, in order."""
    hits = []
    for name in names:
        if name in BLOCKED_PARTIES:
            hits.append(name)
    return hits
