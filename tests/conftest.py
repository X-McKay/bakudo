"""Shared pytest configuration.

* Puts this checkout's ``src/`` ahead of any installed ``bakudo`` so tests in
  a worktree always exercise the tree they live in.
* Registers the markers used by tests that talk to real external services.
  Such tests are always skipped unless their environment variable is set, so
  default runs never touch the network or the sandbox runtime.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

_SRC = str(Path(__file__).resolve().parents[1] / "src")
if _SRC not in sys.path:
    sys.path.insert(0, _SRC)


def pytest_configure(config: pytest.Config) -> None:
    config.addinivalue_line(
        "markers",
        "live: touches live external services; skipped unless the required "
        "environment (e.g. BAKUDO_POSTGRES_DSN, VLLM_EMBED_URL) is configured",
    )
    config.addinivalue_line(
        "markers",
        "live_abox: drives the real abox 0.7.1 binary in a KVM microVM "
        "(skipped unless ABOX_LIVE=1; requires `abox project trust` + "
        "`abox env warm` on this checkout)",
    )
