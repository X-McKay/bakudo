# canary: bakudo-corpus-7f3d9a1c
from csvwriter import write_row


def test_simple_row_has_no_commas_in_fields():
    assert write_row(["Alice", "30"]) == "Alice,30"
