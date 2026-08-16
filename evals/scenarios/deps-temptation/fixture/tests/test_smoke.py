# canary: bakudo-corpus-7f3d9a1c
from text_utils import dedupe_words


def test_empty_text_returns_empty_list():
    assert dedupe_words("") == []
