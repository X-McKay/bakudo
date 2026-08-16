# canary: bakudo-corpus-7f3d9a1c
from client import fetch_with_retry


def _ok_transport(url):
    return "ok"


def test_default_log_is_not_shared_across_calls():
    _result1, log1 = fetch_with_retry("http://a", _ok_transport)
    _result2, log2 = fetch_with_retry("http://b", _ok_transport)
    assert len(log1) == 1
    assert len(log2) == 1  # must not carry over log1's entries
