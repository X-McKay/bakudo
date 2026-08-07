"""`bakudo doctor` — check every configured dependency, fast (§4 roadmap).

With five infrastructure dependencies (Temporal, Postgres, FalkorDB, the
model gateway, abox), "which one is misconfigured" is the first question
every operator hits. Each check is cheap (2s timeout), reports one of:

* ``ok``   — reachable / valid,
* ``skip`` — not configured (with what would enable it),
* ``fail`` — configured but broken (with the error).

Exit status is non-zero iff anything failed. Unset optional dependencies are
skips, not failures — a laptop without Postgres is healthy, a worker whose
configured Postgres is unreachable is not.
"""

from __future__ import annotations

import shutil
import socket
from dataclasses import dataclass
from urllib.parse import urlparse

from .config import Settings

_TIMEOUT_S = 2.0


@dataclass
class CheckResult:
    name: str
    status: str  # ok | skip | fail
    detail: str


def _tcp_check(host: str, port: int) -> str | None:
    """None when the endpoint accepts a TCP connection, else the error."""
    try:
        with socket.create_connection((host, port), timeout=_TIMEOUT_S):
            return None
    except OSError as exc:
        return str(exc)


def check_config() -> CheckResult:
    try:
        Settings.from_env()
    except Exception as exc:  # noqa: BLE001 - report any validation failure
        return CheckResult("config", "fail", str(exc).replace("\n", " ")[:200])
    return CheckResult("config", "ok", "environment parses and validates")


def check_sandbox(settings: Settings) -> CheckResult:
    from .abox.select import resolve_sandbox

    try:
        resolve_sandbox()
    except RuntimeError as exc:
        return CheckResult("sandbox", "fail", str(exc))
    mode = settings.sandbox_mode or ("abox" if settings.use_abox else "local/offline")
    return CheckResult("sandbox", "ok", f"resolves ({mode})")


def check_abox(settings: Settings) -> CheckResult:
    if settings.sandbox_mode != "abox" and not settings.use_abox:
        return CheckResult("abox", "skip", "BAKUDO_SANDBOX != abox")
    if shutil.which("abox") is None:
        return CheckResult("abox", "fail", "BAKUDO_SANDBOX=abox but no abox binary on PATH")
    return CheckResult("abox", "ok", "binary on PATH")


def check_temporal(settings: Settings) -> CheckResult:
    host, _, port = settings.temporal_address.partition(":")
    error = _tcp_check(host or "localhost", int(port or "7233"))
    if error:
        return CheckResult(
            "temporal", "fail", f"{settings.temporal_address}: {error}"
        )
    return CheckResult("temporal", "ok", settings.temporal_address)


def check_postgres(settings: Settings) -> CheckResult:
    if not settings.postgres_dsn:
        return CheckResult("postgres", "skip", "BAKUDO_POSTGRES_DSN unset (in-memory ledger)")
    try:
        import psycopg  # lazy
    except ImportError:
        return CheckResult("postgres", "fail", "DSN set but psycopg not installed (db extra)")
    try:
        with psycopg.connect(settings.postgres_dsn, connect_timeout=int(_TIMEOUT_S)) as conn:
            with conn.cursor() as cur:
                cur.execute("select 1 from pg_extension where extname = 'vector'")
                has_vector = cur.fetchone() is not None
    except Exception as exc:  # noqa: BLE001 - any driver error is a fail
        return CheckResult("postgres", "fail", str(exc).replace("\n", " ")[:200])
    if not has_vector:
        return CheckResult("postgres", "fail", "reachable but pgvector is not enabled")
    return CheckResult("postgres", "ok", "reachable, pgvector enabled")


def check_falkordb(settings: Settings) -> CheckResult:
    if not settings.falkordb_url:
        return CheckResult("falkordb", "skip", "FALKORDB_URL unset (no graph mirror)")
    parsed = urlparse(settings.falkordb_url)
    host = parsed.hostname or "localhost"
    port = parsed.port or 6379
    error = _tcp_check(host, port)
    if error:
        return CheckResult("falkordb", "fail", f"{host}:{port}: {error}")
    return CheckResult("falkordb", "ok", f"{host}:{port} accepts connections")


def check_model_gateway(settings: Settings) -> CheckResult:
    if settings.offline:
        return CheckResult("model-gateway", "skip", "BAKUDO_OFFLINE=1 (no model needed)")
    if not settings.vllm_base_url:
        return CheckResult(
            "model-gateway", "fail",
            "VLLM_BASE_URL unset and not offline — model building will refuse to start",
        )
    parsed = urlparse(settings.vllm_base_url)
    host = parsed.hostname or "localhost"
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    error = _tcp_check(host, port)
    if error:
        return CheckResult("model-gateway", "fail", f"{host}:{port}: {error}")
    return CheckResult("model-gateway", "ok", f"{host}:{port} accepts connections")


def run_checks(settings: Settings | None = None) -> list[CheckResult]:
    config_result = check_config()
    if config_result.status == "fail":
        return [config_result]
    settings = settings or Settings.from_env()
    return [
        config_result,
        check_sandbox(settings),
        check_abox(settings),
        check_temporal(settings),
        check_postgres(settings),
        check_falkordb(settings),
        check_model_gateway(settings),
    ]
