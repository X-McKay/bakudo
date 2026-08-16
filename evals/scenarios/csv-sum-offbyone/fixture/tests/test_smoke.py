# canary: bakudo-corpus-7f3d9a1c
from summer import parse_header


def test_header_parses(tmp_path):
    csv_path = tmp_path / "data.csv"
    csv_path.write_text("amount,label\n1,a\n2,b\n")
    assert parse_header(str(csv_path)) == ["amount", "label"]
