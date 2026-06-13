"""Memory write policy (spec section 14.5).

A memory candidate is rejected if it lacks evidence, is too broad, repeats an
existing memory without adding value, conflicts with stronger evidence, is mere
model speculation, contains secrets, or is scoped incorrectly. Unverified
memories must never be treated as facts (non-goal 2.2.6).
"""

from __future__ import annotations

import re

from .models import MemoryItem

# Minimal secret detectors — conservative, to keep secrets out of durable memory.
_SECRET_PATTERNS = (
    re.compile(r"AKIA[0-9A-Z]{16}"),                      # AWS access key id
    re.compile(r"sk-[A-Za-z0-9]{20,}"),                   # OpenAI-style key
    re.compile(r"ghp_[A-Za-z0-9]{36}"),                   # GitHub PAT
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),    # PEM private key
    re.compile(r"(?i)\b(password|secret|api[_-]?key)\b\s*[:=]\s*\S+"),
)

MIN_CONFIDENCE = 0.5
MIN_CONTENT_LEN = 12


class MemoryRejected(ValueError):
    """Raised (or aggregated) when a memory candidate violates write policy."""


def _contains_secret(text: str) -> bool:
    return any(p.search(text) for p in _SECRET_PATTERNS)


def validate_memory_candidate(
    candidate: MemoryItem, existing: list[MemoryItem] | None = None
) -> list[str]:
    """Return a list of rejection reasons; empty means the candidate is writable."""
    existing = existing or []
    reasons: list[str] = []

    if not candidate.evidence:
        reasons.append("lacks evidence")
    if len(candidate.content.strip()) < MIN_CONTENT_LEN:
        reasons.append("too short / low-information")
    if not candidate.scope:
        reasons.append("scoped incorrectly (no scope)")
    if candidate.confidence < MIN_CONFIDENCE:
        reasons.append(
            f"confidence {candidate.confidence:.2f} below threshold {MIN_CONFIDENCE}"
        )
    if _contains_secret(candidate.content):
        reasons.append("contains a secret")

    normalized = candidate.content.strip().lower()
    for prior in existing:
        if prior.content.strip().lower() == normalized:
            if prior.confidence >= candidate.confidence:
                reasons.append("repeats existing memory without adding value")
            break

    return reasons


def is_acceptable(candidate: MemoryItem, existing: list[MemoryItem] | None = None) -> bool:
    return not validate_memory_candidate(candidate, existing)
