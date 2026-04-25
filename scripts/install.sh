#!/usr/bin/env bash
# install.sh — installer for bakudo.
#
# No binary releases exist yet, so this script installs bakudo from source
# via `cargo install`. It also checks for hard prerequisites (abox on PATH)
# and warns about soft prerequisites (at least one supported provider CLI).
#
# Usage:
#   # from a local checkout of this repo:
#   ./scripts/install.sh
#
#   # from anywhere, via cargo + git (no checkout required, Rust toolchain needed):
#   BAKUDO_INSTALL_MODE=git ./scripts/install.sh
#
# Environment overrides:
#   BAKUDO_INSTALL_MODE   'path' (default, requires repo checkout) | 'git'
#   BAKUDO_GIT_URL        git URL for mode=git (default: https://github.com/X-McKay/bakudo)
#   BAKUDO_GIT_REF        branch/tag/sha for mode=git (default: main)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODE="${BAKUDO_INSTALL_MODE:-path}"
GIT_URL="${BAKUDO_GIT_URL:-https://github.com/X-McKay/bakudo}"
GIT_REF="${BAKUDO_GIT_REF:-main}"

# ─── Color helpers ──────────────────────────────────────────────────────────
if [[ -t 1 ]]; then
    BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'
    YELLOW=$'\033[33m'; CYAN=$'\033[36m'; RESET=$'\033[0m'
else
    BOLD=""; DIM=""; RED=""; GREEN=""; YELLOW=""; CYAN=""; RESET=""
fi
info() { echo "${CYAN}[info]${RESET}  $*"; }
ok()   { echo "${GREEN}[ok]${RESET}    $*"; }
warn() { echo "${YELLOW}[warn]${RESET}  $*" >&2; }
err()  { echo "${RED}[error]${RESET} $*" >&2; }

echo "${BOLD}bakudo installer${RESET}"
echo

# ─── Detect platform ────────────────────────────────────────────────────────
OS="$(uname -s)"
ARCH="$(uname -m)"
if [[ "$OS" != "Linux" ]]; then
    warn "bakudo has only been tested on Linux ($OS detected). The install may still work; report issues at $GIT_URL/issues."
fi
if [[ "$ARCH" != "x86_64" ]]; then
    warn "bakudo has only been tested on x86_64 ($ARCH detected)."
fi

# ─── Prereq: Rust toolchain ─────────────────────────────────────────────────
info "checking prerequisites..."
if ! command -v cargo >/dev/null 2>&1; then
    err "cargo not found on PATH. Install the Rust toolchain first: https://rustup.rs"
    exit 1
fi
ok "cargo: $(cargo --version)"

# ─── Prereq: abox on PATH ───────────────────────────────────────────────────
# Hard prereq — bakudo cannot dispatch without it. Check BEFORE installing
# bakudo so a missing abox doesn't leave the user with a half-working setup.
MIN_ABOX_VERSION="0.3.2"
if ! command -v abox >/dev/null 2>&1; then
    err "abox is not on PATH. bakudo cannot dispatch tasks without it."
    err "Install abox from the bakudo-abox workspace root:  just install-abox"
    err "(or see https://github.com/X-McKay/abox)"
    exit 1
fi
ABOX_VERSION_RAW="$(abox --version 2>&1 | head -1)"
ABOX_VERSION="$(printf '%s' "$ABOX_VERSION_RAW" | sed -nE 's/.*abox ([0-9]+(\.[0-9]+){1,2}).*/\1/p')"
if [[ -z "$ABOX_VERSION" ]]; then
    err "could not parse 'abox --version' output: $ABOX_VERSION_RAW"
    err "bakudo requires abox $MIN_ABOX_VERSION or newer."
    exit 1
fi
if [[ "$(printf '%s\n%s\n' "$MIN_ABOX_VERSION" "$ABOX_VERSION" | sort -V | head -n1)" != "$MIN_ABOX_VERSION" ]]; then
    err "abox $ABOX_VERSION is too old. bakudo requires $MIN_ABOX_VERSION or newer."
    err "Install abox from the bakudo-abox workspace root:  just install-abox"
    exit 1
fi
ok "abox: $ABOX_VERSION_RAW at $(command -v abox)"

# ─── Soft prereq: at least one provider CLI ─────────────────────────────────
# Warn but don't block — the user may install a provider later.
PROVIDERS_PRESENT=()
PROVIDERS_MISSING=()
for provider_bin in claude codex gemini opencode; do
    if command -v "$provider_bin" >/dev/null 2>&1; then
        PROVIDERS_PRESENT+=("$provider_bin")
    else
        PROVIDERS_MISSING+=("$provider_bin")
    fi
done
if [[ ${#PROVIDERS_PRESENT[@]} -eq 0 ]]; then
    warn "no supported provider CLIs found on PATH. bakudo supports: ${PROVIDERS_MISSING[*]}"
    warn "install at least one before dispatching tasks."
else
    ok "providers: ${PROVIDERS_PRESENT[*]}"
    if [[ ${#PROVIDERS_MISSING[@]} -gt 0 ]]; then
        info "missing (optional): ${PROVIDERS_MISSING[*]}"
    fi
fi

# ─── Build + install bakudo ─────────────────────────────────────────────────
echo
case "$MODE" in
    path)
        if [[ ! -f "$REPO_ROOT/Cargo.toml" ]]; then
            err "BAKUDO_INSTALL_MODE=path requires running this script from a bakudo checkout. Try BAKUDO_INSTALL_MODE=git ./scripts/install.sh"
            exit 1
        fi
        info "installing bakudo from local checkout at $REPO_ROOT"
        cargo install --path "$REPO_ROOT" --force
        ;;
    git)
        info "installing bakudo from git ($GIT_URL @ $GIT_REF)"
        cargo install --git "$GIT_URL" --branch "$GIT_REF" --force bakudo
        ;;
    *)
        err "unknown BAKUDO_INSTALL_MODE: $MODE (expected 'path' or 'git')"
        exit 1
        ;;
esac

BAKUDO_BIN="$(command -v bakudo || true)"
if [[ -z "$BAKUDO_BIN" ]]; then
    err "bakudo was installed but is not on PATH. Make sure ~/.cargo/bin is on your PATH."
    exit 1
fi
ok "installed: $BAKUDO_BIN ($("$BAKUDO_BIN" --version))"

# ─── Summary ────────────────────────────────────────────────────────────────
echo
echo "${BOLD}next steps:${RESET}"
echo "  1. Run ${CYAN}bakudo doctor${RESET} to verify the full stack is healthy."
echo "  2. Run ${CYAN}bakudo${RESET} with no args to launch the TUI in the current directory."
echo "     (bakudo uses the current git repo as the workspace root.)"
echo
echo "See the README at ${DIM}$GIT_URL${RESET} for configuration and usage."
