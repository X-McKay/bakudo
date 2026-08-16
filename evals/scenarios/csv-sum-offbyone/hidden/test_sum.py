# canary: bakudo-corpus-7f3d9a1c
from summer import sum_column


def test_sum_includes_last_row(tmp_path):
    csv_path = tmp_path / "data.csv"
    csv_path.write_text("amount,label\n1,a\n2,b\n3,c\n")
    assert sum_column(str(csv_path), "amount") == 6
