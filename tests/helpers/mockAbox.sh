#!/usr/bin/env bash
set -euo pipefail

REPO=""
COMMAND=""
TASK_ID=""
EPHEMERAL=0
CLEAN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      REPO="$2"
      shift 2
      ;;
    run|merge|stop)
      COMMAND="$1"
      shift
      break
      ;;
    --capabilities)
      COMMAND="--capabilities"
      shift
      break
      ;;
    *)
      break
      ;;
  esac
done

while [[ $# -gt 0 ]]; do
  case "$1" in
    --task)
      TASK_ID="$2"
      shift 2
      ;;
    --ephemeral)
      EPHEMERAL=1
      shift
      ;;
    --clean)
      CLEAN=1
      shift
      ;;
    --)
      break
      ;;
    *)
      shift
      ;;
  esac
done

if [[ "$COMMAND" == "--capabilities" ]]; then
  cat <<'JSON'
{"protocolVersions":[1,3],"taskKinds":["assistant_job","explicit_command","verification_check"],"executionEngines":["agent_cli","shell"]}
JSON
  exit 0
fi

if [[ -z "$REPO" ]]; then
  echo "mockAbox.sh requires --repo" >&2
  exit 2
fi

log_file="$(git -C "$REPO" rev-parse --git-path bakudo-mock.log)"
if [[ "$log_file" != /* ]]; then
  log_file="$REPO/$log_file"
fi
mkdir -p "$(dirname "$log_file")"
printf '%s task=%s repo=%s\n' "$COMMAND" "${TASK_ID:-}" "$REPO" >> "$log_file"

find_worktree() {
  git -C "$REPO" worktree list --porcelain | awk -v expected="refs/heads/agent/$TASK_ID" '
    $1 == "worktree" { path = $2; next }
    $1 == "branch" && $2 == expected { print path; exit }
  '
}

case "$COMMAND" in
  run)
    if [[ $EPHEMERAL -eq 0 ]]; then
      worktree_path="$(find_worktree || true)"
      if [[ -z "$worktree_path" ]]; then
        worktree_path="$(mktemp -d "${TMPDIR:-/tmp}/bakudo-mock-${TASK_ID}-XXXXXX")"
        if git -C "$REPO" show-ref --verify --quiet "refs/heads/agent/$TASK_ID"; then
          git -C "$REPO" worktree add "$worktree_path" "agent/$TASK_ID" >/dev/null
        else
          git -C "$REPO" worktree add -b "agent/$TASK_ID" "$worktree_path" HEAD >/dev/null
        fi
      fi
      mkdir -p "$worktree_path/.bakudo/out/$TASK_ID"
      printf 'mock run for %s\n' "$TASK_ID" > "$worktree_path/.bakudo/out/$TASK_ID/summary.md"
    fi
    ;;
  merge)
    worktree_path="$(find_worktree || true)"
    if [[ -z "$worktree_path" ]]; then
      echo "no preserved worktree found for task $TASK_ID" >&2
      exit 3
    fi
    if [[ -n "$(git -C "$worktree_path" status --porcelain)" ]]; then
      git -C "$worktree_path" add -A
      if ! git -C "$worktree_path" diff --cached --quiet; then
        git -C "$worktree_path" commit -m "mock merge ${TASK_ID}" >/dev/null
      fi
    fi
    git -C "$REPO" merge --ff-only "agent/$TASK_ID" >/dev/null
    ;;
  stop)
    if [[ $CLEAN -eq 1 ]]; then
      worktree_path="$(find_worktree || true)"
      if [[ -n "$worktree_path" ]]; then
        git -C "$REPO" worktree remove --force "$worktree_path" >/dev/null
      fi
    fi
    ;;
  *)
    echo "unsupported mock abox command: ${COMMAND:-<none>}" >&2
    exit 2
    ;;
esac
