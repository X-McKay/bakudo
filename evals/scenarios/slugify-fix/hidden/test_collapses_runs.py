# canary: bakudo-corpus-7f3d9a1c
from slugify import slugify


def test_double_space_collapses_to_single_hyphen():
    assert slugify("a  b") == "a-b"


def test_multiple_punctuation_collapses_to_single_hyphen():
    assert slugify("a!!!b") == "a-b"
