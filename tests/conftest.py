"""Shared pytest configuration.

Registers the markers used by tests that talk to real external services.
Such tests are always skipped unless their environment variable is set, so
default runs never touch the network or the sandbox runtime.
"""

from __future__ import annotations

import pytest


def pytest_configure(config: pytest.Config) -> None:
    config.addinivalue_line(
        "markers",
        "live: touches live external services; skipped unless the required "
        "environment (e.g. BAKUDO_POSTGRES_DSN, VLLM_EMBED_URL) is configured",
    )
    config.addinivalue_line(
        "markers",
        "live_abox: drives the real abox 0.6.0 binary in a KVM microVM "
        "(skipped unless ABOX_LIVE=1; requires `abox project trust` + "
        "`abox env warm` on this checkout)",
    )
