# canary: bakudo-corpus-7f3d9a1c
from app import total_price


def test_total_price_multiplies_price_by_qty():
    assert total_price([{"price": 2.0, "qty": 3}]) == 6.0
