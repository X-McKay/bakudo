# canary: bakudo-corpus-7f3d9a1c
import pytest

from validator import DEFAULT_LIMIT, validate_limit


def test_limit_well_above_default_raises():
    with pytest.raises(ValueError):
        validate_limit(DEFAULT_LIMIT + 100)
