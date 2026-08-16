# canary: bakudo-corpus-7f3d9a1c
from dedupe_orders import dedupe_orders


def test_later_duplicate_wins():
    orders = [
        {"id": "o1", "status": "pending"},
        {"id": "o2", "status": "pending"},
        {"id": "o1", "status": "shipped"},
    ]
    result = dedupe_orders(orders)
    assert result == [
        {"id": "o1", "status": "shipped"},
        {"id": "o2", "status": "pending"},
    ]
