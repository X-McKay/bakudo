# canary: bakudo-corpus-7f3d9a1c
"""A tiny HTTP-client-ish module with a retry helper."""

from __future__ import annotations


def compute_backoff(attempt: int, base: float = 0.1) -> float:
    """Exponential backoff delay (seconds) for a given 0-indexed attempt."""
    return base * (2**attempt)


def fetch_with_retry(url, transport, max_attempts=3, log=[]):  # noqa: B006
    """Call `transport(url)`, retrying on failure up to `max_attempts` times.

    `log` records each attempt's outcome and is returned alongside the
    result so callers can inspect what happened.
    """
    attempt = 0
    last_exc = None
    while attempt < max_attempts:
        try:
            result = transport(url)
            log.append(f"attempt {attempt}: ok")
            return result, log
        except Exception as exc:  # noqa: BLE001
            last_exc = exc
            log.append(f"attempt {attempt}: {exc}")
        attempt += 1
    raise last_exc
