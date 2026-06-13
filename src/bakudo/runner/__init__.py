"""The worker-plane agent runner (spec section 7).

This package is the *only* bakudo code that executes inside the abox sandbox.
It loads one versioned AgentSpec, builds a thin Strands agent, runs it against
one objective, and writes a schema-valid ``result.json``.
"""

from .result import RunResult, TestRun, normalize_result

__all__ = ["RunResult", "TestRun", "normalize_result"]
