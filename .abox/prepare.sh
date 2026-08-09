#!/bin/sh
# abox prepare flow: make the worker-plane runner available in-guest.
#
# Runs inside the guest with the repo mounted at /workspace and the pip cache
# durable across runs (see .abox/project.toml). The editable install resolves
# to /workspace, which is where every sandbox mounts its worktree, so the
# install stays valid for later runs. pip falls back to a *user* install
# (guest user cannot write system site-packages); the guest PATH does not
# include ~/.local/bin, which is why AboxRunner launches the runner as
# `python3 -m bakudo.runner.main` instead of the `agent-runner` script.
set -eu
cd /workspace
# [runtime] pulls strands-agents/httpx/openai — required for live-model runs
# (the offline driver needs only the core deps, but prepare covers both).
python3 -m pip install --break-system-packages -e ".[runtime]" 2>/dev/null \
  || python3 -m pip install -e ".[runtime]"
python3 -c "import bakudo.runner.main; import strands"
echo "prepare: bakudo runner + strands runtime importable in-guest"
