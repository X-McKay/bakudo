#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
TARGET_REPO=${1:-}
URL=${2:-https://example.com}
ABOX_BIN=${3:-abox}

if [[ -z "$TARGET_REPO" ]]; then
  echo "usage: $0 /path/to/repo [url] [abox-binary]" >&2
  exit 1
fi

node "$ROOT_DIR/dist/src/cli.js" \
  --goal "python3 - <<'PY'
import json
import ssl
import urllib.request

url = '$URL'
ctx = ssl.create_default_context()
with urllib.request.urlopen(url, timeout=15, context=ctx) as resp:
    body = resp.read(256)
    print(json.dumps({
        'url': url,
        'status': resp.status,
        'bytes_preview': len(body),
        'content_type': resp.headers.get('content-type', ''),
    }))
PY" \
  --config "$ROOT_DIR/examples/plan-mode.json" \
  --streams network \
  --repo "$TARGET_REPO" \
  --abox-bin "$ABOX_BIN"
