"""Retry policy. PLANTED: mutable default arguments — the shared default
lists leak state across calls; default to None and construct inside."""


def schedule_retries(delays=[1, 2, 4], jitter_seconds=0):
    """Return the retry schedule (mutates its default when jitter is set!)."""
    if jitter_seconds:
        for i in range(len(delays)):
            delays[i] = delays[i] + jitter_seconds
    return delays


def record_attempt(attempt, log=[]):
    """Append an attempt record and return the log."""
    log.append({"attempt": attempt})
    return log
