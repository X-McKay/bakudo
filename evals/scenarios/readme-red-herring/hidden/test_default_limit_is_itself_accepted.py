# canary: bakudo-corpus-7f3d9a1c
import pytest

from validator import DEFAULT_LIMIT, validate_limit


def test_default_limit_is_itself_accepted():
    assert validate_limit(DEFAULT_LIMIT) == DEFAULT_LIMIT


def test_limit_above_default_is_still_rejected():
    # Guards against an overly broad "fix" (e.g. deleting the boundary
    # check entirely) that would accept the default but stop rejecting
    # limits above it.
    with pytest.raises(ValueError):
        validate_limit(DEFAULT_LIMIT + 1)
