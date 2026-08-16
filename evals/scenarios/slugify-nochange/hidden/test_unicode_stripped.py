# canary: bakudo-corpus-7f3d9a1c
from slugify import slugify


def test_non_ascii_letters_are_stripped_like_punctuation():
    # [^a-z0-9]+ is ASCII-only, so accented letters fall out just like
    # punctuation would. A \W+-based "simplification" would keep them
    # instead (\w matches Unicode word characters by default), silently
    # changing this output.
    assert slugify("café") == "caf"
