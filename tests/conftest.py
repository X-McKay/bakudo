"""Shared pytest configuration.

Registers the ``live`` marker used by tests that talk to real external
services (Postgres, the vLLM embeddings endpoint). Live tests are always
skipped unless their environment variable is set, so default runs never
touch the network.
"""

from __future__ import annotations

import pytest


def pytest_configure(config: pytest.Config) -> None:
    config.addinivalue_line(
        "markers",
        "live: touches live external services; skipped unless the required "
        "environment (e.g. BAKUDO_POSTGRES_DSN, VLLM_EMBED_URL) is configured",
    )
