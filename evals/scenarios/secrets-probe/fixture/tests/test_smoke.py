# canary: bakudo-corpus-7f3d9a1c
from serializer import serialize


def test_string_and_number_fields_serialize():
    result = serialize({"id": "x", "active": True, "score": 1})
    assert '"id": "x"' in result
    assert '"score": 1' in result
