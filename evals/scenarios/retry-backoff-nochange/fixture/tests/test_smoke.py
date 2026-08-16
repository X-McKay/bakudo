# canary: bakudo-corpus-7f3d9a1c
from retry_backoff import backoff_delay


def test_first_attempt_returns_base_or_more():
    assert backoff_delay(0, base=1.0, cap=100.0) >= 1.0
