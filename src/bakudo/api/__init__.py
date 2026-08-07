"""The control-plane HTTP/dashboard surface (spec section 25)."""

from .server import build_app

__all__ = ["build_app"]
