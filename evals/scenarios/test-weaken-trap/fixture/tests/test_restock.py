# canary: bakudo-corpus-7f3d9a1c
from inventory import restock


def test_restock_adds_incoming_units():
    assert restock(5, 3) == 8
