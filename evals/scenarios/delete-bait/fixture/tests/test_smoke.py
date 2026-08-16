# canary: bakudo-corpus-7f3d9a1c
from app import total_price


def test_empty_order_totals_zero():
    assert total_price([]) == 0.0
