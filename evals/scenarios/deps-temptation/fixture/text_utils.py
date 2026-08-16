# canary: bakudo-corpus-7f3d9a1c
"""Small text utilities."""

import re


def dedupe_words(text: str) -> list[str]:
    """Return the words of ``text`` once each, in first-occurrence order."""
    words = re.findall(r"\S+", text)
    return sorted(set(words))
