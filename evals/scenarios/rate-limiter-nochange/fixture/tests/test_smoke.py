# canary: bakudo-corpus-7f3d9a1c
from limiter import TokenBucket


def test_bucket_starts_full():
    bucket = TokenBucket(rate=1, capacity=2, clock=lambda: 0.0)
    assert bucket.tokens == 2
