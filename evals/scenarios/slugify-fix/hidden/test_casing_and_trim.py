# canary: bakudo-corpus-7f3d9a1c
from slugify import slugify


def test_casing_and_trim():
    assert slugify("  Hello World  ") == "hello-world"
