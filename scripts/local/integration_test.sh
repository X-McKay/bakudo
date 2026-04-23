#!/usr/bin/env bash
#
# integration_test.sh — run bakudo's Rust integration + runtime test suites.
#
# The Rust tests under tests/runtime.rs and tests/integration.rs use a fake
# abox script via write_fake_abox_script, so they don't require a real abox
# binary. They do require the abox CLI contract to be stable.
#
# Optionally, setting BAKUDO_INTEGRATION_LIVE=1 additionally runs a real
# end-to-end dispatch against the abox on PATH — microVM boot, provider
# round-trip, worktree discarded. This path needs /dev/kvm + a working
# provider CLI + valid API credentials.
#
# Usage:
#   ./scripts/local/integration_test.sh
#   BAKUDO_INTEGRATION_LIVE=1 ./scripts/local/integration_test.sh
#
# Exit codes:
#   0 — all tests passed (and the live probe if enabled)
#   1 — a Rust test suite failed
#   2 — prereqs missing (rust toolchain, abox, provider)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

if [[ -t 1 ]]; then
    BOLD=$'\033[1m'; DIM=$'\033[2m'; GREEN=$'\033[32m'
    YELLOW=$'\033[33m'; RED=$'\033[31m'; CYAN=$'\033[36m'; RESET=$'\033[0m'
else
    BOLD=""; DIM=""; GREEN=""; YELLOW=""; RED=""; CYAN=""; RESET=""
fi
section() { echo; echo "${BOLD}${CYAN}=== $1 ===${RESET}"; }
ok()      { echo "  ${GREEN}ok${RESET} $1"; }
warn()    { echo "  ${YELLOW}!!${RESET} $1" >&2; }
err()     { echo "  ${RED}FAIL${RESET} $1" >&2; }

# ─── Prereqs ────────────────────────────────────────────────────────────────
section "Prereqs"

if ! command -v cargo >/dev/null 2>&1; then
    err "cargo not on PATH — install the Rust toolchain (https://rustup.rs)"
    exit 2
fi
ok "cargo: $(cargo --version)"

# ─── Rust test suite (always runs) ──────────────────────────────────────────
section "Rust workspace tests"
cargo test --workspace --release
ok "cargo test --workspace passed"

# ─── Optional live dispatch ─────────────────────────────────────────────────
if [[ "${BAKUDO_INTEGRATION_LIVE:-0}" != "1" ]]; then
    echo
    echo "${DIM}skip: live dispatch (set BAKUDO_INTEGRATION_LIVE=1 to enable)${RESET}"
    echo
    echo "${BOLD}${GREEN}integration tests passed${RESET}"
    exit 0
fi

section "Live dispatch (BAKUDO_INTEGRATION_LIVE=1)"

if ! command -v abox >/dev/null 2>&1; then
    err "abox not on PATH — install with 'just install-abox' from the workspace root"
    exit 2
fi
ok "abox: $(abox --version)"

# Provider: claude by default, override via BAKUDO_INTEGRATION_PROVIDER.
PROVIDER="${BAKUDO_INTEGRATION_PROVIDER:-claude}"
if ! command -v "$PROVIDER" >/dev/null 2>&1; then
    err "provider '$PROVIDER' not on PATH — install it or set BAKUDO_INTEGRATION_PROVIDER"
    exit 2
fi
ok "provider: $PROVIDER ($($PROVIDER --version 2>&1 | head -1))"

if [[ ! -c /dev/kvm ]] || [[ ! -r /dev/kvm ]]; then
    warn "/dev/kvm not readable — live dispatch may fail"
fi

# Build the bakudo binary under test (not `cargo install`: keep it local).
cargo build --release --bin bakudo
BAKUDO_BIN="$REPO_ROOT/target/release/bakudo"
ok "built: $BAKUDO_BIN ($("$BAKUDO_BIN" --version))"

PROMPT='Reply with exactly TEST_OK and nothing else.'
echo "  dispatching prompt via $PROVIDER (timeout 90s)..."
# --discard cleans up the worktree after success. --approve-execution is a
# no-op unless the local config has a review policy configured.
set +e
"$BAKUDO_BIN" run --provider "$PROVIDER" --discard "$PROMPT" >/tmp/bakudo-integration-live.log 2>&1
RC=$?
set -e
if [[ $RC -ne 0 ]]; then
    err "live dispatch failed (exit $RC). Last 40 lines:"
    tail -40 /tmp/bakudo-integration-live.log >&2 || true
    exit 1
fi
if ! grep -q "Task finished: Succeeded" /tmp/bakudo-integration-live.log; then
    err "live dispatch did not report success. Last 40 lines:"
    tail -40 /tmp/bakudo-integration-live.log >&2 || true
    exit 1
fi
ok "live dispatch succeeded"
echo "  log: /tmp/bakudo-integration-live.log"

echo
echo "${BOLD}${GREEN}integration tests + live dispatch passed${RESET}"
