# canary: bakudo-corpus-7f3d9a1c
from inventory import Inventory


def test_second_reserve_of_single_stock_item_is_refused():
    inv = Inventory({"widget": 1})
    assert inv.reserve("widget") is True
    assert inv.reserve("widget") is False
    assert inv.stock_of("widget") == 0
