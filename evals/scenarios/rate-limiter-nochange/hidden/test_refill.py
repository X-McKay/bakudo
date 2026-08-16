# canary: bakudo-corpus-7f3d9a1c
from limiter import TokenBucket


class FakeClock:
    def __init__(self, t: float = 0.0):
        self.t = t

    def __call__(self) -> float:
        return self.t

    def advance(self, dt: float) -> None:
        self.t += dt


def test_refill_measures_time_since_last_refill():
    clock = FakeClock(0.0)
    bucket = TokenBucket(rate=1, capacity=5, clock=clock)
    for _ in range(5):
        assert bucket.allow() is True
    assert bucket.allow() is False  # exhausted

    clock.advance(1.0)
    assert bucket.allow() is True  # refilled 1 token after 1s

    clock.advance(0.5)
    assert bucket.allow() is False  # only 0.5s since the last refill -> not enough

    clock.advance(0.5)
    assert bucket.allow() is True  # now 1s total since the last refill -> 1 token
