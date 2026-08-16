# canary: bakudo-corpus-7f3d9a1c
from client import compute_backoff


def test_backoff_is_positive():
    assert compute_backoff(0) > 0
