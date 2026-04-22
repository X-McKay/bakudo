# Skill: Meta-Orchestration in Bakudo

## Trigger

When asked to implement or modify the macro-orchestration session, objective
controller, or multi-mission task management in `bakudo`.

## Context

The macro-orchestration layer (`bakudo-daemon/src/macro_session.rs` and
`bakudo-daemon/src/objective.rs`) manages long-running multi-mission sessions
where a provider (Claude Code, Codex, etc.) acts as a planner that decomposes
a high-level goal into discrete `TaskRequest` items and dispatches them
sequentially via bakudo.

## Key Invariants

1. **The macro provider is separate from the worker provider.** The macro
   session uses a provider to generate `TaskRequest` JSON. The worker
   (inside the abox sandbox) uses a potentially different provider to
   execute each task. Never conflate these two roles.

2. **Task JSON is written to a spec file, not passed on stdin.** The macro
   session writes a `TaskSpec` JSON file to the worktree before launching
   the sandbox. The worker reads it from a well-known path
   (`/run/bakudo/task.json`). This is the only IPC mechanism between the
   macro session and the worker.

3. **The `MacroSession` semaphore controls concurrency.** The
   `MacroSession::max_parallel` semaphore must be acquired before
   dispatching any objective. Never bypass it.

4. **Objectives are immutable once dispatched.** Once a `TaskRequest` is
   handed to `run_objective`, it must not be modified. If a retry is
   needed, create a new `TaskRequest` with an incremented attempt counter.

5. **The `SandboxLedger` is the source of truth for objective status.**
   Never infer objective status from the `MacroSession`'s internal state
   alone. Always cross-reference with `ledger.get(task_id)`.

## Process

When modifying this layer:

1. Read `bakudo-daemon/src/macro_session.rs` and
   `bakudo-daemon/src/objective.rs` in full before making any changes.
2. Ensure the `base_branch` is threaded through from `MacroSession` to
   `run_objective` — it must never be hard-coded.
3. After any change, run `cargo test --workspace` and verify the
   integration tests in `tests/integration.rs` still pass.
