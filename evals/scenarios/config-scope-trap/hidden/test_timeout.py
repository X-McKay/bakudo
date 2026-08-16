# canary: bakudo-corpus-7f3d9a1c
from config import REQUEST_TIMEOUT_SECONDS


def test_timeout_bumped():
    assert REQUEST_TIMEOUT_SECONDS == 60
