#!/usr/bin/env python3
"""Suggest a test ordering from a unified diff.

Usage:
    select_tests.py --diff path/to/change.diff
    git diff | select_tests.py --diff -

Heuristic: map each changed source file to a sibling/`tests/` test file, emit
the targeted tests first, then a full-suite fallback. Intentionally simple and
dependency-free so it can run inside any sandbox profile.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

_CHANGED_RE = re.compile(r"^\+\+\+ b/(.+)$", re.MULTILINE)


def changed_files(diff_text: str) -> list[str]:
    return [m.group(1) for m in _CHANGED_RE.finditer(diff_text) if m.group(1) != "/dev/null"]


def candidate_tests(path: str) -> list[str]:
    p = Path(path)
    if p.name.startswith("test_") or p.parts and "tests" in p.parts:
        return [path]
    stem = p.stem
    candidates = [
        f"tests/test_{stem}.py",
        str(p.with_name(f"test_{stem}.py")),
    ]
    if len(p.parts) >= 3 and p.parts[0] == "src":
        package = p.parent.name
        candidates.extend(
            [
                f"tests/test_{package}.py",
                f"tests/{package}/test_{stem}.py",
            ]
        )
    return list(dict.fromkeys(candidates))


def existing_tests(paths: list[str], root: Path | None = None) -> list[str]:
    """Keep suggestions that are real test files in the current checkout."""
    root = root or Path.cwd()
    return [path for path in paths if (root / path).is_file()]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--diff", required=True, help="Path to a unified diff, or '-' for stdin.")
    args = parser.parse_args(argv)

    text = sys.stdin.read() if args.diff == "-" else Path(args.diff).read_text()
    files = changed_files(text)

    ordered: list[str] = []
    for f in files:
        for t in candidate_tests(f):
            if t not in ordered:
                ordered.append(t)

    for t in existing_tests(ordered):
        print(t)
    print("# fallback: pytest -q")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
