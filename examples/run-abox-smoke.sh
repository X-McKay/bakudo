#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
ABOX_DIR="$ROOT_DIR/abox"
BAKUDO_DIR="$ROOT_DIR/bakudo"

if ! command -v cargo >/dev/null 2>&1; then
  echo "missing dependency: cargo" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "missing dependency: node" >&2
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "missing dependency: pnpm" >&2
  exit 1
fi

if [[ ! -e /dev/kvm ]]; then
  echo "missing dependency: /dev/kvm" >&2
  exit 1
fi

echo "[1/4] build abox"
cargo build --manifest-path "$ABOX_DIR/Cargo.toml" --bin abox

echo "[2/4] install bakudo deps"
pnpm --dir "$BAKUDO_DIR" install --frozen-lockfile

echo "[3/4] build bakudo"
pnpm --dir "$BAKUDO_DIR" build

echo "[4/4] run bakudo against abox"
node "$BAKUDO_DIR/dist/src/cli.js" \
  --goal "pwd && git status --short --branch" \
  --config "$BAKUDO_DIR/config/default.json" \
  --streams smoke-1 \
  --abox-bin "$ABOX_DIR/target/debug/abox"
