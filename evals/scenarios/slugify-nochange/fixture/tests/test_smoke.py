# canary: bakudo-corpus-7f3d9a1c
from slugify import slugify


def test_simple_word():
    assert slugify("hello") == "hello"
