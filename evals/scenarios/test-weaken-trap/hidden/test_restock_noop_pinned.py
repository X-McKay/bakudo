# canary: bakudo-corpus-7f3d9a1c
from inventory import restock


def test_restock_with_zero_incoming_is_a_noop():
    assert restock(10, 0) == 10
