"""Central, validated runtime configuration (§18, §24).

Every environment variable bakudo reads is declared exactly once here — typed,
described, and defaulted — and every subsystem resolves its configuration
through :meth:`Settings.from_env`. That gives three things the scattered
``os.environ.get`` calls could not:

* one place to see (and validate) the whole configuration surface,
* ``bakudo config list`` / ``bakudo config describe`` for operators, driven by
  the same field metadata,
* loud failures for values that must not be guessed (see
  :func:`bakudo.runner.agent._resolve_base_url`).

``Settings.from_env()`` reads the live environment on every call — cheap, and
it keeps test ``monkeypatch.setenv`` semantics intact. There is deliberately
no cached global.

One exception stays env-computed by design: ``BAKUDO_VLLM_<REF>`` (per-spec
model gateway refs, §19.4) is a *family* of variables keyed by the spec's
``baseUrlRef`` and cannot be a fixed field.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


def _env(name: str, *, secret: bool = False) -> dict[str, Any]:
    return {"env": name, "secret": secret}


class Settings(BaseModel):
    """The complete bakudo environment configuration."""

    model_config = ConfigDict(frozen=True)

    # --- Temporal ---
    temporal_address: str = Field(
        default="localhost:7233",
        description="Temporal frontend host:port the worker and client connect to.",
        json_schema_extra=_env("TEMPORAL_ADDRESS"),
    )
    temporal_namespace: str = Field(
        default="default",
        description="Temporal namespace for all bakudo workflows.",
        json_schema_extra=_env("TEMPORAL_NAMESPACE"),
    )
    activity_threads: int = Field(
        default=8,
        ge=1,
        description="Worker thread-pool size for synchronous activities.",
        json_schema_extra=_env("BAKUDO_ACTIVITY_THREADS"),
    )

    # --- Ledger / memory backends ---
    postgres_dsn: str | None = Field(
        default=None,
        description="Postgres DSN for the durable ledger + pgvector memory. "
        "Unset = in-memory (dev only).",
        json_schema_extra=_env("BAKUDO_POSTGRES_DSN", secret=True),
    )
    falkordb_url: str | None = Field(
        default=None,
        description="FalkorDB URL (redis://[:password@]host:port) for the "
        "optional graph memory mirror. May embed credentials, so it is "
        "masked in display.",
        json_schema_extra=_env("FALKORDB_URL", secret=True),
    )
    falkordb_graph: str = Field(
        default="bakudo",
        description="FalkorDB graph name the memory mirror writes to.",
        json_schema_extra=_env("FALKORDB_GRAPH"),
    )

    # --- Model gateway ---
    vllm_base_url: str | None = Field(
        default=None,
        description="Default OpenAI-compatible model gateway base URL. Model "
        "building fails loudly when neither this nor the spec's "
        "BAKUDO_VLLM_<REF> variable is set.",
        json_schema_extra=_env("VLLM_BASE_URL"),
    )
    vllm_api_key: str | None = Field(
        default=None,
        description="API key for the model gateway (optional for local vLLM).",
        json_schema_extra=_env("VLLM_API_KEY", secret=True),
    )

    # --- Control API ---
    api_token: str | None = Field(
        default=None,
        description="Bearer token required on mutating API routes. Unset "
        "disables auth (dev only).",
        json_schema_extra=_env("BAKUDO_API_TOKEN", secret=True),
    )
    api_host: str = Field(
        default="127.0.0.1",
        description="Bind host for the control API.",
        json_schema_extra=_env("BAKUDO_API_HOST"),
    )
    api_port: int = Field(
        default=8000,
        ge=1,
        le=65535,
        description="Bind port for the control API.",
        json_schema_extra=_env("BAKUDO_API_PORT"),
    )

    # --- Execution / sandbox ---
    sandbox_mode: str | None = Field(
        default=None,
        description="Sandbox driver: 'abox' (production) or 'local' "
        "(dev/offline only). Unset fails closed — no sandbox is picked "
        "implicitly.",
        json_schema_extra=_env("BAKUDO_SANDBOX"),
    )
    use_abox: bool = Field(
        default=False,
        description="Legacy alias: '1' behaves like BAKUDO_SANDBOX=abox.",
        json_schema_extra=_env("BAKUDO_USE_ABOX"),
    )
    sandbox_concurrency: int | None = Field(
        default=None,
        ge=1,
        le=64,
        description="Max concurrent sandbox executions (admission gate). "
        "Unset = min(16, max(2, cores*2)).",
        json_schema_extra=_env("BAKUDO_SANDBOX_CONCURRENCY"),
    )
    env: str | None = Field(
        default=None,
        description="Deployment environment; 'dev' additionally permits the "
        "local sandbox.",
        json_schema_extra=_env("BAKUDO_ENV"),
    )
    offline: bool = Field(
        default=False,
        description="'1' bypasses the model entirely with the no-LLM offline "
        "driver (placeholder results; used by `bakudo demo`).",
        json_schema_extra=_env("BAKUDO_OFFLINE"),
    )

    # --- Curriculum collectors ---
    repo_path: str | None = Field(
        default=None,
        description="Local repo checkout the TODO collector scans.",
        json_schema_extra=_env("BAKUDO_REPO_PATH"),
    )
    coverage_xml: str | None = Field(
        default=None,
        description="Cobertura coverage.xml the coverage-gap collector reads.",
        json_schema_extra=_env("BAKUDO_COVERAGE_XML"),
    )
    junit_xml: str | None = Field(
        default=None,
        description="JUnit XML report the failing-test collector reads.",
        json_schema_extra=_env("BAKUDO_JUNIT_XML"),
    )
    github_token: str | None = Field(
        default=None,
        description="GitHub token for the issues collector (owner/repo objectives).",
        json_schema_extra=_env("GITHUB_TOKEN", secret=True),
    )

    @classmethod
    def from_env(cls, environ: Mapping[str, str] | None = None) -> Settings:
        """Build settings from the (live) environment, validating types."""
        environ = os.environ if environ is None else environ
        values: dict[str, Any] = {}
        for name, field in cls.model_fields.items():
            extra = field.json_schema_extra or {}
            raw = environ.get(extra.get("env", ""))  # type: ignore[union-attr, arg-type]
            if raw is None or raw == "":
                continue
            if field.annotation is bool:
                values[name] = raw == "1"
            else:
                values[name] = raw
        return cls.model_validate(values)

    @classmethod
    def describe(cls) -> list[dict[str, Any]]:
        """Field metadata rows for `bakudo config list|describe`."""
        rows = []
        for name, field in cls.model_fields.items():
            extra = dict(field.json_schema_extra or {})  # type: ignore[arg-type]
            rows.append(
                {
                    "field": name,
                    "env": extra.get("env", ""),
                    "default": field.default,
                    "secret": bool(extra.get("secret", False)),
                    "description": field.description or "",
                }
            )
        return rows

    def display_value(self, field_name: str) -> str:
        """The current value, masked for secrets, for operator display."""
        value = getattr(self, field_name)
        rows = {r["field"]: r for r in self.describe()}
        if value is None:
            return "<unset>"
        if rows[field_name]["secret"]:
            return "*****"
        return str(value)
