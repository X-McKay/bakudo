#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
TARGET_REPO=${1:-}
ABOX_BIN=${2:-abox}

if [[ -z "$TARGET_REPO" ]]; then
  echo "usage: $0 /path/to/repo [abox-binary]" >&2
  exit 1
fi

node "$ROOT_DIR/dist/src/cli.js" \
  --goal "pwd && echo '== test files ==' && (rg --files . | rg '(^|/)(test|tests|__tests__)/|\\.(test|spec)\\.(js|ts|tsx|py|rs|go)$' || true) && echo && echo '== package manifests ==' && (rg --files . | rg '(^|/)(package.json|pyproject.toml|Cargo.toml|go.mod)$' || true)" \
  --config "$ROOT_DIR/examples/plan-mode.json" \
  --streams tests \
  --repo "$TARGET_REPO" \
  --abox-bin "$ABOX_BIN"
