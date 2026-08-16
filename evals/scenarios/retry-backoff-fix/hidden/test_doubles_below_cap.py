# canary: bakudo-corpus-7f3d9a1c
from retry_backoff import backoff_delay


def test_doubles_below_cap():
    assert backoff_delay(0, base=1.0, cap=100.0) == 1.0
    assert backoff_delay(1, base=1.0, cap=100.0) == 2.0
    assert backoff_delay(2, base=1.0, cap=100.0) == 4.0
