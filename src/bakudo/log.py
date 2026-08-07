"""Structured JSON logging with run correlation (§18).

One stdlib-only setup shared by every process: JSON lines on stderr, one
event per line, with the canonical run id (see :mod:`bakudo.ids`) attached to
every record logged inside a :func:`bound_run` block. No print() statements
in ``src/`` — the session log is the analytics substrate, so it has to be
parseable.

Usage::

    from bakudo.log import configure_logging, get_logger, bound_run

    configure_logging()               # entrypoints, once; idempotent
    log = get_logger(__name__)
    with bound_run(run_id):
        log.info("sandbox started", extra={"context": {"agent": spec.ref}})
"""

from __future__ import annotations

import contextvars
import json
import logging
import sys
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from typing import Any

_run_id: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "bakudo_run_id", default=None
)

_HANDLER_NAME = "bakudo-json"


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": datetime.now(UTC).isoformat(),
            "level": record.levelname.lower(),
            "logger": record.name,
            "message": record.getMessage(),
        }
        run_id = _run_id.get()
        if run_id:
            payload["run_id"] = run_id
        context = getattr(record, "context", None)
        if isinstance(context, dict):
            payload.update(context)
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str)


def configure_logging(level: str = "INFO") -> None:
    """Install the JSON handler on the root logger (idempotent)."""
    root = logging.getLogger()
    if any(h.get_name() == _HANDLER_NAME for h in root.handlers):
        root.setLevel(level)
        return
    handler = logging.StreamHandler(sys.stderr)
    handler.set_name(_HANDLER_NAME)
    handler.setFormatter(JsonFormatter())
    root.addHandler(handler)
    root.setLevel(level)


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(name)


@contextmanager
def bound_run(run_id: str) -> Iterator[None]:
    """Attach the canonical run id to every record logged in this block."""
    token = _run_id.set(run_id)
    try:
        yield
    finally:
        _run_id.reset(token)
