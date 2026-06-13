"""Load and serialise AgentSpec YAML documents."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

from ..schema import validate_agent_spec
from .models import AgentSpec


def parse_spec(document: dict[str, Any], *, validate: bool = True) -> AgentSpec:
    """Validate (optionally) against JSON Schema and parse into an AgentSpec."""
    if validate:
        validate_agent_spec(document)
    return AgentSpec.model_validate(document)


def load_spec(text: str, *, validate: bool = True) -> AgentSpec:
    """Parse an AgentSpec from a YAML string."""
    document = yaml.safe_load(text)
    if not isinstance(document, dict):
        raise ValueError("AgentSpec YAML must be a mapping at the top level.")
    return parse_spec(document, validate=validate)


def load_spec_file(path: str | Path, *, validate: bool = True) -> AgentSpec:
    """Parse an AgentSpec from a YAML file on disk."""
    return load_spec(Path(path).read_text(), validate=validate)


def dump_yaml(spec: AgentSpec) -> str:
    """Serialise an AgentSpec back to canonical YAML."""
    return yaml.safe_dump(spec.to_dict(), sort_keys=False)
