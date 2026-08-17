"""Skill discovery and progressive disclosure (spec section 13.3).

The agent should *not* load every skill into context. Instead:

1. It sees only skill names and descriptions (the discovery manifest).
2. It calls ``load_skill`` when a skill appears relevant.
3. The full ``SKILL.md`` and supporting resources are loaded only then.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

from ..paths import skills_dir

_FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n(.*)$", re.DOTALL)


def parse_skill_frontmatter(text: str) -> tuple[dict[str, Any], str]:
    """Split a ``SKILL.md`` into (frontmatter dict, body)."""
    match = _FRONTMATTER_RE.match(text)
    if not match:
        return {}, text
    front = yaml.safe_load(match.group(1)) or {}
    return front, match.group(2)


@dataclass
class Skill:
    """A discovered skill package on disk."""

    name: str
    description: str
    path: Path

    def body(self) -> str:
        """The full ``SKILL.md`` body (loaded on demand)."""
        _, body = parse_skill_frontmatter((self.path / "SKILL.md").read_text())
        return body

    def references(self) -> list[str]:
        ref_dir = self.path / "references"
        if not ref_dir.is_dir():
            return []
        return sorted(p.name for p in ref_dir.iterdir() if p.is_file())

    def scripts(self) -> list[str]:
        script_dir = self.path / "scripts"
        if not script_dir.is_dir():
            return []
        return sorted(p.name for p in script_dir.iterdir() if p.is_file())


class SkillRegistry:
    """Discovers skills on disk and exposes progressive-disclosure access.

    ``allowed`` is the AgentSpec's list of exact skill package names; only
    those skills are discoverable by the agent.
    """

    def __init__(self, allowed: list[str] | None = None, root: Path | None = None) -> None:
        self._root = root or skills_dir()
        self._allowed = None if allowed is None else frozenset(allowed)
        self._skills: dict[str, Skill] = {}
        self._discover()

    def _discover(self) -> None:
        if not self._root.is_dir():
            return
        for child in sorted(self._root.iterdir()):
            skill_md = child / "SKILL.md"
            if not skill_md.is_file():
                continue
            front, _ = parse_skill_frontmatter(skill_md.read_text())
            name = front.get("name", child.name)
            self._skills[name] = Skill(
                name=name,
                description=front.get("description", ""),
                path=child,
            )

    def _is_allowed(self, name: str) -> bool:
        if self._allowed is None:
            return True
        return name in self._allowed

    def available(self) -> list[Skill]:
        return [s for s in self._skills.values() if self._is_allowed(s.name)]

    def discovery_manifest(self) -> list[dict[str, str]]:
        """Return the minimal name/description list shown up front."""
        return [{"name": s.name, "description": s.description} for s in self.available()]

    def get(self, name: str) -> Skill:
        if name not in self._skills:
            raise KeyError(f"Unknown skill: {name}")
        if not self._is_allowed(name):
            raise PermissionError(f"Skill '{name}' is not in this agent's allowlist.")
        return self._skills[name]

    def load_skill(self, name: str) -> dict[str, Any]:
        """Full disclosure of a skill (body + resource listings)."""
        skill = self.get(name)
        return {
            "name": skill.name,
            "description": skill.description,
            "body": skill.body(),
            "references": skill.references(),
            "scripts": skill.scripts(),
        }
