"""Focused tests for the discoverability and machine-facing CLI contract."""

from __future__ import annotations

import json

import pytest

from bakudo.cli import build_parser, main


def test_parser_can_be_built_and_inspected_without_execution():
    args = build_parser().parse_args(["doctor", "--json"])

    assert args.command == "doctor"
    assert args.json is True


def test_top_level_help_exposes_grouped_commands(capsys):
    with pytest.raises(SystemExit, match="0"):
        main(["--help"])

    out = capsys.readouterr().out
    assert "bakudo doctor" in out
    assert "bakudo agent validate" in out
    assert "bakudo skill list" in out
    assert "validate-spec" not in out


def test_agent_list_json(capsys):
    assert main(["agent", "list", "--json"]) == 0

    records = json.loads(capsys.readouterr().out)
    assert records
    assert {"ref", "name", "role", "status"} == records[0].keys()


def test_agent_validate_json(capsys):
    assert main(["agent", "validate", "agents/add-feature.yaml", "--json"]) == 0

    record = json.loads(capsys.readouterr().out)
    assert record["ref"] == "add-feature@1"
    assert record["path"].endswith("/agents/add-feature.yaml")


def test_agent_validate_reports_a_clean_error(tmp_path, capsys):
    broken = tmp_path / "broken.yaml"
    broken.write_text("not: an-agent-spec\n")

    assert main(["agent", "validate", str(broken)]) == 1
    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err.startswith("error: ")


def test_skill_list_json_has_the_progressive_disclosure_manifest(capsys):
    assert main(["skill", "list", "--json"]) == 0

    manifest = json.loads(capsys.readouterr().out)
    assert manifest
    assert {"name", "description"} == manifest[0].keys()


def test_doctor_json_and_strict_mode(monkeypatch, capsys):
    monkeypatch.setenv("BAKUDO_OFFLINE", "1")
    monkeypatch.delenv("BAKUDO_POSTGRES_DSN", raising=False)

    assert main(["doctor", "--json"]) == 0
    report = json.loads(capsys.readouterr().out)
    assert report["ok"] is True
    assert report["warnings"] >= 1
    assert {check["name"] for check in report["checks"]} >= {
        "agent-specs",
        "skills",
        "task-source",
        "execution",
        "persistence",
    }

    assert main(["doctor", "--strict"]) == 1


@pytest.mark.parametrize(
    "argv",
    [
        ["optimize", "--repo", "r", "--title", "t", "--rounds", "0"],
        ["optimize", "--repo", "r", "--title", "t", "--max-files", "-1"],
        ["trial", "run", "task", "--agent", "agent", "--seed", "-1"],
        ["experiment", "profile", "agent", "--count", "0"],
    ],
)
def test_numeric_arguments_reject_invalid_values(argv):
    with pytest.raises(SystemExit, match="2"):
        main(argv)
