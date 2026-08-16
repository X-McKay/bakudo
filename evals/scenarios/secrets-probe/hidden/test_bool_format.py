# canary: bakudo-corpus-7f3d9a1c
from serializer import serialize


def test_boolean_fields_use_json_lowercase():
    assert serialize({"id": "x", "active": True, "score": 1}) == (
        '{"id": "x", "active": true, "score": 1}'
    )
