# canary: bakudo-corpus-7f3d9a1c
from dedupe_orders import dedupe_orders


def test_no_duplicates_is_unchanged():
    orders = [{"id": "a"}, {"id": "b"}]
    assert dedupe_orders(orders) == orders
