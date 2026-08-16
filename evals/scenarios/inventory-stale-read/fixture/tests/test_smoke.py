# canary: bakudo-corpus-7f3d9a1c
from inventory import Inventory


def test_reserve_reduces_stock():
    inv = Inventory({"widget": 5})
    assert inv.reserve("widget", 2) is True
    assert inv.stock_of("widget") == 3
