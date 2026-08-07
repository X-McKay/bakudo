"""Fail-closed sandbox selection shared by every execution path (§6, §19).

The in-process :func:`~bakudo.abox.local.local_sandbox` is not an isolation
boundary, so it is never selected implicitly:

* ``BAKUDO_SANDBOX=abox`` (or the legacy ``BAKUDO_USE_ABOX=1``) selects the
  abox microVM runner.
* ``BAKUDO_SANDBOX=local`` is permitted only in dev (``BAKUDO_ENV=dev``) or
  offline mode (``BAKUDO_OFFLINE=1``, where no model runs and the built-in
  offline driver never executes tools).
* ``BAKUDO_OFFLINE=1`` alone also resolves to the local sandbox, for the same
  reason — the offline driver produces a canned result without touching the
  repository.
* Anything else raises rather than guessing.

Both the synchronous pipeline (:mod:`bakudo.control.pipeline`) and the
Temporal activity layer (:mod:`bakudo.temporal._impl`) resolve through here,
so the guarantee holds on the CLI/API path, not just under Temporal.
"""

from __future__ import annotations

import os
from collections.abc import Callable

from ..bundle import TaskBundle
from .runner import AboxOutcome, AboxRunner

SandboxFn = Callable[[TaskBundle], AboxOutcome]


def _local_allowed() -> bool:
    return (
        os.environ.get("BAKUDO_ENV") == "dev"
        or os.environ.get("BAKUDO_OFFLINE") == "1"
    )


def resolve_sandbox(explicit: SandboxFn | None = None) -> SandboxFn:
    """Resolve the sandbox driver, failing *closed* when unconfigured."""
    if explicit is not None:
        return explicit

    mode = os.environ.get("BAKUDO_SANDBOX")
    if mode is None and os.environ.get("BAKUDO_USE_ABOX") == "1":
        mode = "abox"  # backwards-compatible alias

    if mode == "abox":
        return AboxRunner().run
    if mode == "local":
        if not _local_allowed():
            raise RuntimeError(
                "BAKUDO_SANDBOX=local requires BAKUDO_ENV=dev or "
                "BAKUDO_OFFLINE=1; the local sandbox is not an isolation "
                "boundary."
            )
        from .local import local_sandbox

        return local_sandbox
    if mode is None:
        if os.environ.get("BAKUDO_OFFLINE") == "1":
            from .local import local_sandbox

            return local_sandbox
        raise RuntimeError(
            "BAKUDO_SANDBOX must be set to 'abox' or 'local' (local is "
            "dev/offline-only). Refusing to pick a sandbox implicitly."
        )
    raise RuntimeError(f"Unknown BAKUDO_SANDBOX value: {mode!r}")
