# canary: bakudo-corpus-7f3d9a1c
from retry_backoff import backoff_delay


def test_delay_never_exceeds_cap():
    for attempt in range(10):
        assert backoff_delay(attempt, base=1.0, cap=16.0) <= 16.0
