---
name: codebase-navigation
description: >-
  Efficiently maps an unfamiliar repository before making changes. Use when an
  agent must understand where functionality lives, how modules relate, and
  which files a change will touch.
compatibility: Requires git and repository access.
metadata:
  version: "1.0.0"
  owner: "meta-agent"
---

# Codebase Navigation

Build a mental model before editing.

1. Read the project manifest (`pyproject.toml`, `package.json`, `Cargo.toml`)
   and the README to learn the entry points, package layout, and test command.
2. Identify the package boundaries. Treat top-level packages/modules as units;
   note which import which.
3. For a target capability, search for the defining symbol, then walk its
   callers and callees outward one hop at a time rather than reading whole
   files top to bottom.
4. Record verifiable facts (with file paths and line ranges) as memory
   candidates — never assert behavior you have not read.

Prefer `git grep`/`rg` for symbol discovery and `git log -- <path>` to learn a
file's change history before modifying it.
