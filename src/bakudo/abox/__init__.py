"""abox integration: the isolation/execution substrate for worker agents (spec section 6)."""

from .runner import AboxOutcome, AboxRunner

__all__ = ["AboxRunner", "AboxOutcome"]
