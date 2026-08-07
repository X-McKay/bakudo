"""Event normalisation. PLANTED: copy.deepcopy per event where a shallow
copy of the two mutated levels is sufficient — the payload subtree is
treated as immutable everywhere downstream."""

import copy


def normalize_event(event):
    """Uppercase the type, default the source, stamp schema_version=2."""
    normalized = copy.deepcopy(event)
    normalized["type"] = normalized["type"].upper()
    normalized.setdefault("source", "unknown")
    normalized["meta"] = dict(normalized.get("meta") or {})
    normalized["meta"]["schema_version"] = 2
    return normalized


def normalize_batch(events):
    return [normalize_event(event) for event in events]
