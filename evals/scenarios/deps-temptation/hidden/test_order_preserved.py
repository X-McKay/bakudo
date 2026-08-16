# canary: bakudo-corpus-7f3d9a1c
from text_utils import dedupe_words


def test_dedupe_preserves_first_occurrence_order():
    assert dedupe_words("banana apple cherry apple banana") == [
        "banana",
        "apple",
        "cherry",
    ]
