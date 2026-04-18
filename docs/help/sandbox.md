# bakudo sandbox

bakudo never runs agent commands on the host. Every dispatched command
executes inside an abox sandbox — a Cloud Hypervisor microVM with
git-worktree isolation and credential-proxying.

## The abox boundary

- abox owns the VM lifecycle: create, run, destroy.
- bakudo speaks to abox via the CLI adapter: `abox [--repo <path>] run
  --task <id> --ephemeral -- <command...>`.
- Each invocation generates a unique task ID
  (`bakudo-<stream>-<seq>`) so concurrent streams don't collide.

## `--ephemeral` semantics

`--ephemeral` tells abox to create a fresh microVM for this invocation
and destroy it on exit. bakudo defaults to ephemeral dispatch:

- No state persists between invocations by default.
- Each task boots into its own git worktree, derived from the
  configured `--repo`.
- The guest rootfs includes bash, Node.js, Claude Code CLI, and Codex
  CLI; additional tools must be baked into the rootfs ahead of time.

Non-ephemeral dispatches are reserved for the long-running sandbox
session case and are not routed through the default bakudo paths.

## Worktree lifecycle

- On dispatch, abox creates a new git worktree in its managed
  workspace and mounts it into the microVM.
- On exit, the worktree is collected — any uncommitted changes live
  in the artifact store (see the `/inspect artifacts` tab).
- Output artifacts (diffs, logs, attachments) are persisted under
  `<repo>/.bakudo/artifacts/<session>/<attempt>/`.

## Capability negotiation

`abox --capabilities` reports a string tag (`v1`, `v2`, ...). bakudo
defaults to assuming `v1` when the flag is not recognized. Use
`bakudo doctor` to surface the effective capability tag.

## Related

- `bakudo help permissions` — what the sandbox enforces.
- `bakudo help hooks` — pre- and post-dispatch hooks.
- `bakudo help monitoring` — how to observe sandbox dispatches.
- `plans/bakudo-ux/handoffs/phase-4.md` — provenance record shape
  emitted around every dispatch.
