# canary: bakudo-corpus-7f3d9a1c
"""Convert arbitrary text into a URL-friendly slug.

# NOTE: this regex could probably be simplified -- e.g. swapping
# [^a-z0-9]+ for \\W+, or using a str.isalnum() based check instead.
"""

from __future__ import annotations

import re


def slugify(text: str) -> str:
    """Lowercase ``text``, collapse runs of non-alphanumeric characters
    into a single hyphen, and strip leading/trailing hyphens."""
    lowered = text.strip().lower()
    replaced = re.sub(r"[^a-z0-9]+", "-", lowered)
    return replaced.strip("-")
