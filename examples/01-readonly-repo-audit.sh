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
  --goal "pwd && git status --short --branch && echo && git log --oneline -5 && echo && (rg -n 'TODO|FIXME|HACK' . || true)" \
  --config "$ROOT_DIR/examples/plan-mode.json" \
  --streams audit \
  --repo "$TARGET_REPO" \
  --abox-bin "$ABOX_BIN"
