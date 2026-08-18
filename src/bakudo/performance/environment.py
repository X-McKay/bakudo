"""Load explicit environment pins for reproducible operator workflows."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import yaml

from .pins import EnvironmentPin

_ENVIRONMENT_VAR = "BAKUDO_PERFORMANCE_ENVIRONMENT"


class EnvironmentPinLoadError(ValueError):
    """A configured performance environment pin is absent or invalid."""


def load_environment_pin(path: Path) -> EnvironmentPin:
    """Load a JSON or YAML environment pin without inventing host identity."""

    resolved = path.expanduser().resolve()
    try:
        text = resolved.read_text()
        document: Any = (
            json.loads(text)
            if resolved.suffix.lower() == ".json"
            else yaml.safe_load(text)
        )
        if not isinstance(document, dict):
            raise ValueError("document must be an object")
        return EnvironmentPin.model_validate(document)
    except (OSError, ValueError, yaml.YAMLError) as exc:
        raise EnvironmentPinLoadError(f"invalid environment pin {resolved}: {exc}") from exc


def configured_environment_pin(path: str | Path | None = None) -> EnvironmentPin:
    """Resolve an explicit CLI path or the standard environment variable."""

    value = str(path) if path is not None else os.environ.get(_ENVIRONMENT_VAR)
    if not value:
        raise EnvironmentPinLoadError(
            "a pinned measurement environment is required; pass --environment PATH "
            f"or set {_ENVIRONMENT_VAR}"
        )
    return load_environment_pin(Path(value))
