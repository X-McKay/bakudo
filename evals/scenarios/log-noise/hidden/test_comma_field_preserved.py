# canary: bakudo-corpus-7f3d9a1c
from csvwriter import write_row


def test_field_containing_a_comma_is_quoted_not_truncated():
    assert write_row(["Smith, John", "42 Main St"]) == '"Smith, John",42 Main St'
