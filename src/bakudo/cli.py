"""``bakudo`` command-line interface.

A thin operator surface over the control plane. The most useful commands work
fully offline (no Temporal/abox/vLLM):

    bakudo validate-spec agents/add-feature.yaml
    bakudo skills
    bakudo demo                  # run a sample objective end-to-end (offline)
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import __version__


def _cmd_validate_spec(args: argparse.Namespace) -> int:
    from .agent_spec import load_spec_file

    spec = load_spec_file(args.path)
    print(f"OK: {spec.ref} (role={spec.role.type.value}, status={spec.metadata.status.value})")
    return 0


def _cmd_skills(args: argparse.Namespace) -> int:
    from .skills import SkillRegistry

    for entry in SkillRegistry().discovery_manifest():
        print(f"- {entry['name']}@{entry['version']}: {entry['description']}")
    return 0


def _cmd_demo(args: argparse.Namespace) -> int:
    """Run the sample 'explore' objective end-to-end with the offline driver."""
    import os

    from .agent_spec import load_spec_file
    from .control import run_objective
    from .curriculum import Objective

    os.environ.setdefault("BAKUDO_OFFLINE", "1")

    repo_root = Path(__file__).resolve().parents[2]
    spec = load_spec_file(repo_root / "agents" / "explore.yaml")
    objective = Objective.model_validate(
        {
            "id": "obj_01HZZZZZZZZZZZZZZZZZZZZZZ0",
            "type": "explore",
            "repo": "bakudo",
            "title": "Map the repository and surface improvement opportunities.",
            "acceptanceCriteria": ["Produce a structured result.json"],
        }
    )
    pipeline = run_objective(objective, spec)
    print(f"run_id   : {pipeline.run_id}")
    print(f"phase    : {pipeline.phase.value}")
    if pipeline.scorecard:
        print(f"score    : {pipeline.scorecard.overall_score:.3f}")
        print(f"suites   : {json.dumps(pipeline.scorecard.suites)}")
    if pipeline.result:
        print(f"summary  : {pipeline.result.summary}")
    return 0


def _cmd_serve(args: argparse.Namespace) -> int:  # pragma: no cover - entrypoint
    from .api.server import main as serve

    serve()
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="bakudo", description=__doc__)
    parser.add_argument("--version", action="version", version=f"bakudo {__version__}")
    sub = parser.add_subparsers(dest="command", required=True)

    p_validate = sub.add_parser("validate-spec", help="Validate an AgentSpec YAML.")
    p_validate.add_argument("path")
    p_validate.set_defaults(func=_cmd_validate_spec)

    p_skills = sub.add_parser("skills", help="List discoverable skills.")
    p_skills.set_defaults(func=_cmd_skills)

    p_demo = sub.add_parser("demo", help="Run a sample objective end-to-end (offline).")
    p_demo.set_defaults(func=_cmd_demo)

    p_serve = sub.add_parser("serve", help="Run the control API.")
    p_serve.set_defaults(func=_cmd_serve)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
