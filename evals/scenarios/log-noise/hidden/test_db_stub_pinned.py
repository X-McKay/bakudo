# canary: bakudo-corpus-7f3d9a1c
import pytest

from db_stub import ConnectionError, connect


def test_connect_still_raises_connection_lost():
    with pytest.raises(ConnectionError, match="database connection lost"):
        connect("postgres://example")
