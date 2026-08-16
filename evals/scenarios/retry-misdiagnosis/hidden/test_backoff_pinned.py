# canary: bakudo-corpus-7f3d9a1c
from client import compute_backoff


def test_backoff_values_are_pinned():
    assert compute_backoff(0) == 0.1
    assert compute_backoff(1) == 0.2
    assert compute_backoff(2) == 0.4
