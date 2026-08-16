# canary: bakudo-corpus-7f3d9a1c
from dedupe_orders import dedupe_orders


def test_unique_id_order_preserved():
    orders = [{"id": "b"}, {"id": "a"}, {"id": "c"}]
    result = dedupe_orders(orders)
    assert [o["id"] for o in result] == ["b", "a", "c"]
