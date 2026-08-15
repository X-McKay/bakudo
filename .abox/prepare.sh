#!/bin/sh
# abox prepare flow: make the worker-plane runner available in-guest.
#
# Under abox 0.7.0 (MicroSandbox runtime) every sandbox boots a fresh OCI
# guest and only the declared caches persist (see .abox/project.toml), so
# this script runs twice: `abox env warm` runs it to keep the pip download
# cache hot, and AboxRunner chains it at the start of every run command to
# actually install the runner into that run's guest (fast against the warm
# cache). The editable install resolves to /workspace, where each sandbox
# mounts its worktree. pip may land console scripts on or off the guest
# PATH depending on system-vs-user install, which is why AboxRunner launches
# the runner as `python3 -m bakudo.runner.main`, never `agent-runner`.
set -eu
cd /workspace
# [runtime] pulls strands-agents/httpx/openai — required for live-model runs
# (the offline driver needs only the core deps, but prepare covers both).
python3 -m pip install --break-system-packages -e ".[runtime]" 2>/dev/null \
  || python3 -m pip install -e ".[runtime]"
python3 -c "import bakudo.runner.main; import strands"
echo "prepare: bakudo runner + strands runtime importable in-guest"
