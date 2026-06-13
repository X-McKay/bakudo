---
name: test-selection
description: >-
  Selects the smallest relevant test set for a code change. Use when an agent
  modifies files and needs to decide which tests to run before reporting
  completion.
compatibility: Requires Python, git, and repository access.
metadata:
  version: "1.0.0"
  owner: "meta-agent"
---

# Test Selection

When files change, inspect imports, nearby tests, package boundaries, and prior
failure history. Prefer targeted tests first, then broader suites if the change
touches shared infrastructure.

Heuristics:

- For a changed module `pkg/foo.py`, run `tests/test_foo.py` and any test file
  importing `pkg.foo` first.
- If the change touches a shared utility imported widely, escalate to the full
  suite.
- Always finish with the project's fast smoke command if one exists.

Run `scripts/select_tests.py --diff <diff-file>` to get a suggested ordering
from a unified diff.
