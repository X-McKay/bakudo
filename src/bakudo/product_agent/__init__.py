"""Stable black-box product-agent process boundary.

This package deliberately owns execution and artifact export only.  It never
imports Bakudo's evaluation, experiment, comparison, or promotion modules.
"""

from .contracts import (
    PRODUCT_AGENT_SCHEMA_V1,
    PatchMetadata,
    ProductAgentResult,
    ProductAgentStatus,
    RuntimeMetadata,
    UsageMetadata,
)
from .service import ProductAgentInputError, run_product_agent

__all__ = [
    "PRODUCT_AGENT_SCHEMA_V1",
    "PatchMetadata",
    "ProductAgentInputError",
    "ProductAgentResult",
    "ProductAgentStatus",
    "RuntimeMetadata",
    "UsageMetadata",
    "run_product_agent",
]
