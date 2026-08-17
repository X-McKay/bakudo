# canary: bakudo-corpus-7f3d9a1c
from limiter import TokenBucket


class FakeClock:
    def __init__(self, t: float = 0.0):
        self.t = t

    def __call__(self) -> float:
        return self.t

    def advance(self, dt: float) -> None:
        self.t += dt


def test_initial_capacity_exhausts_exactly():
    clock = FakeClock(0.0)
    bucket = TokenBucket(rate=1, capacity=3, clock=clock)
    assert [bucket.allow() for _ in range(4)] == [True, True, True, False]
