#!/bin/bash
# Dispatched by bakudo into the abox sandbox VM.
# Runs claude code in autonomous mode against the PR1 brief.
set -euo pipefail

cd /workspace

echo "==> Sandbox PR1 dispatcher starting"
echo "==> Branch: $(git rev-parse --abbrev-ref HEAD)"
echo "==> hostCli.ts: $(wc -l < src/hostCli.ts) lines"
echo "==> Claude: $(claude --version)"
echo "==> Brief: $(wc -l < .bakudo-ux-briefs/pr1-extract-hostcli.md) lines"

# Configure git identity so the in-VM commit works.
git config user.email "bakudo-ux-agent@anthropic.local"
git config user.name "Bakudo UX Agent (in-VM)"

# Run claude code autonomously. The brief is self-contained.
claude --dangerously-skip-permissions --print "$(cat <<'PROMPT'
You are an autonomous coding agent. Read the file
`.bakudo-ux-briefs/pr1-extract-hostcli.md` in the current directory in
full, then execute every instruction in that brief. Do not stop until
its "Definition of done" section is satisfied:

- 6 new files exist under src/host/
- src/hostCli.ts is under 80 lines and is a thin entry point
- All 5 public exports (HostCliArgs, parseHostArgs, shouldUseHostCli,
  reviewedOutcomeExitCode, runHostCli) are still importable from
  ./hostCli.js
- `mise run check` exits 0
- `mise exec -- pnpm test` passes
- One commit with the prescribed message is on the current branch
- A final report is printed to stdout

Constraints to remember while working:
- This is a pure extraction. Zero behavior change.
- No new dependencies.
- No file may exceed 400 lines.
- Do not touch anything under `abox/` or outside /workspace.
- Do not skip checks, do not use --no-verify, do not use --amend.
- Do not edit or delete the brief file.

Begin now. Use TodoWrite, run the tools you need, and produce one commit
on this branch when done.
PROMPT
)"

echo "==> Dispatcher complete. Final git log:"
git log --oneline -3
