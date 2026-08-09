"""Shared pytest config.

* Puts this checkout's ``src/`` ahead of any installed ``bakudo`` so tests in
  a worktree always exercise the tree they live in.
* Registers the ``live`` marker: tests that talk to real external services.
  They must skip themselves unless the relevant env (e.g.
  ``BAKUDO_POSTGRES_DSN``) is explicitly set — normal test runs never connect
  to anything.
"""

from __future__ import annotations

import sys
from pathlib import Path

_SRC = str(Path(__file__).resolve().parents[1] / "src")
if _SRC not in sys.path:
    sys.path.insert(0, _SRC)


def pytest_configure(config):
    config.addinivalue_line(
        "markers",
        "live: touches live external services; skipped unless the required "
        "env vars (e.g. BAKUDO_POSTGRES_DSN) are set",
    )
