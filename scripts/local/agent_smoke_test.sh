#!/usr/bin/env bash
#
# agent_smoke_test.sh — real-API end-to-end smoke test for bakudo dispatch.
#
# For each provider in $BAKUDO_SMOKE_PROVIDERS (default: "claude"):
#   1. Dispatch a trivial prompt that writes + commits one file.
#   2. Verify the task succeeded and produced a commit.
#   3. Apply the worktree into main (in a temporary throwaway repo).
#   4. Discard the worktree.
#
# This DOES hit real provider APIs and costs tokens. Runs against a brand-new
# git repo in a temp dir, so your working checkout is not affected — but your
# abox state dir ($HOME/.abox) and bakudo ledger at
# $HOME/.local/share/bakudo accumulate entries for each dispatch.
#
# Usage:
#   ./scripts/local/agent_smoke_test.sh
#   BAKUDO_SMOKE_PROVIDERS="claude codex" ./scripts/local/agent_smoke_test.sh
#
# Exit codes:
#   0 — all providers passed
#   1 — at least one provider failed
#   2 — prereqs missing
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PROVIDERS="${BAKUDO_SMOKE_PROVIDERS:-claude}"

if [[ -t 1 ]]; then
    BOLD=$'\033[1m'; GREEN=$'\033[32m'
    YELLOW=$'\033[33m'; RED=$'\033[31m'; CYAN=$'\033[36m'; RESET=$'\033[0m'
else
    BOLD=""; GREEN=""; YELLOW=""; RED=""; CYAN=""; RESET=""
fi
section() { echo; echo "${BOLD}${CYAN}=== $1 ===${RESET}"; }
ok()      { echo "  ${GREEN}ok${RESET} $1"; }
warn()    { echo "  ${YELLOW}!!${RESET} $1" >&2; }
err()     { echo "  ${RED}FAIL${RESET} $1" >&2; }

# ─── Prereqs ────────────────────────────────────────────────────────────────
section "Prereqs"

for bin in cargo abox git; do
    if ! command -v "$bin" >/dev/null 2>&1; then
        err "$bin not on PATH"
        exit 2
    fi
done
ok "tooling: cargo, abox, git"
ok "abox: $(abox --version 2>&1 | head -1)"

for provider in $PROVIDERS; do
    if ! command -v "$provider" >/dev/null 2>&1; then
        err "provider '$provider' not on PATH (from BAKUDO_SMOKE_PROVIDERS)"
        exit 2
    fi
done
ok "providers requested: $PROVIDERS"

# Build bakudo (reuse the release target — not cargo install).
cargo build --release --bin bakudo --manifest-path "$REPO_ROOT/Cargo.toml" >/dev/null
BAKUDO_BIN="$REPO_ROOT/target/release/bakudo"
ok "built: $BAKUDO_BIN"

# ─── Scratch repo ───────────────────────────────────────────────────────────
section "Scratch repo"
SCRATCH="$(mktemp -d -t bakudo-smoke.XXXXXX)"
trap 'rm -rf "$SCRATCH"' EXIT
pushd "$SCRATCH" >/dev/null
git init -q -b main
git config user.email "smoke@bakudo.local"
git config user.name "bakudo-smoke"
echo "# smoke" > README.md
git add README.md
git commit -q -m "initial"
ok "scratch repo at $SCRATCH"

# ─── Per-provider dispatch ──────────────────────────────────────────────────
FAILED=()
for provider in $PROVIDERS; do
    section "Dispatch via $provider"
    PROMPT='Create a file smoke.txt containing exactly the word OK. Then run: git add smoke.txt && git commit -m "smoke: add smoke.txt".'
    LOG="$SCRATCH/$provider.log"
    echo "  prompt: $PROMPT"
    echo "  log:    $LOG"

    set +e
    "$BAKUDO_BIN" run --provider "$provider" "$PROMPT" >"$LOG" 2>&1
    RC=$?
    set -e
    if [[ $RC -ne 0 ]]; then
        err "$provider: dispatch exited $RC"
        tail -20 "$LOG" >&2
        FAILED+=("$provider:dispatch")
        continue
    fi
    if ! grep -q "Task finished: Succeeded" "$LOG"; then
        err "$provider: no 'Task finished: Succeeded' in log"
        tail -20 "$LOG" >&2
        FAILED+=("$provider:no-success")
        continue
    fi
    TASK_ID="$(grep -oE 'bakudo-attempt-[0-9a-f-]+' "$LOG" | head -1)"
    if [[ -z "$TASK_ID" ]]; then
        err "$provider: could not parse task_id from log"
        FAILED+=("$provider:no-task-id")
        continue
    fi
    ok "$provider: task $TASK_ID succeeded"

    # Apply — should produce a merge commit or be rejected cleanly.
    set +e
    "$BAKUDO_BIN" apply "$TASK_ID" >"$LOG.apply" 2>&1
    APPLY_RC=$?
    set -e
    if [[ $APPLY_RC -ne 0 ]]; then
        warn "$provider: apply exited $APPLY_RC (see $LOG.apply)"
    else
        if git log --oneline -1 main | grep -q "smoke\|Merge agent/"; then
            ok "$provider: apply produced a main-branch update"
        else
            warn "$provider: apply reported success but main is unchanged (uncommitted residue?)"
        fi
    fi

    # Discard — idempotent cleanup.
    "$BAKUDO_BIN" discard "$TASK_ID" >/dev/null 2>&1 || warn "$provider: discard failed"
    ok "$provider: cleaned up"
done

popd >/dev/null

# ─── Summary ────────────────────────────────────────────────────────────────
echo
if [[ ${#FAILED[@]} -eq 0 ]]; then
    echo "${BOLD}${GREEN}smoke test passed for: $PROVIDERS${RESET}"
    exit 0
else
    echo "${BOLD}${RED}smoke test failures:${RESET}"
    for f in "${FAILED[@]}"; do
        echo "  - $f"
    done
    exit 1
fi
