# Bakudo Examples

These examples are small, runnable entry points for exercising `bakudo` against a real repo through `abox`.

Current constraint: `bakudo` runs each tool call in a fresh ephemeral `abox` sandbox, so these examples are designed to produce useful stdout and traces rather than durable repo edits.

## Prerequisites

- `cargo`
- `node`
- `pnpm`
- `/dev/kvm`
- a working `abox` VM setup

Build `bakudo` first:

```bash
pnpm --dir /home/al/git/bakudo install
pnpm --dir /home/al/git/bakudo build
```

## Examples

### 1. Read-only repo audit

Runs a safe inspection pass: current branch state, recent commits, and obvious TODO/FIXME markers.

```bash
./bakudo/examples/01-readonly-repo-audit.sh /path/to/repo
```

### 2. Test surface scan

Finds common test directories and test/spec files. Useful for quickly checking whether a repo has meaningful automated coverage.

```bash
./bakudo/examples/02-test-surface-scan.sh /path/to/repo
```

### 3. Outbound network smoke

Confirms the sandbox can make a basic HTTPS request. This is useful when validating `abox` network policy and guest runtime setup.

```bash
./bakudo/examples/03-network-smoke.sh /path/to/repo https://example.com
```

## Notes

- All examples accept an optional second argument for the `abox` binary path.
- The read-only examples use [`plan-mode.json`](./plan-mode.json), which forces `bakudo` to use the read-only `shell` tool instead of `shell_write`.
- The network smoke still runs through `shell`, because the current planner only emits `git_status` plus one shell step.
