# Archived Plan Alignment Checklist

Target spec: `docs/archive/bakudo-v2-architecture-and-implementation-plan.md`

This checklist tracks the concrete work needed to move the current Rust runtime back toward the archived v2 supervisor/wake design while preserving the restored chat-first host layer and existing runtime behavior.

## Runtime Architecture

- [x] Introduce archived-plan domain types in `bakudo-core`:
  `Mission`, `Experiment`, `WakeEvent`, `Blackboard`, `Wallet`, `UserMessage`, `LedgerEntry`, `Posture`, and related ids/status enums.
- [x] Add durable mission storage close to the archived plan:
  persisted missions, experiments, wakes, blackboards, ledger entries, user messages, active waves, lessons, and wake provenance snapshots.
- [x] Evolve the current host/session path into a real supervisor-style loop:
  wake queue, wake coalescing, wallet enforcement, and mission resume after restart.
- [x] Preserve the current `SandboxLedger` and timeout classification behavior in `crates/bakudo-core/src/abox.rs`.

## Deliberator + Tooling

- [x] Replace the hard-wired provider worker launch path for autonomous missions with a Deliberator runner that exchanges tool calls with Bakudo over stdio.
- [x] Implement the planned tool surface with a shared `meta` sidecar on every response:
  `dispatch_swarm`, `abox_exec`, `abox_apply_patch`, `host_exec`, `update_blackboard`, `record_lesson`, `ask_user`, `cancel_experiments`, `suspend`.
- [x] Add mission/explore posture handling and autonomous multi-wave dispatch/wake behavior.
- [x] Move provider/prompt loading toward `.bakudo/providers/*.toml` and `.bakudo/prompts/*.md`, with sensible defaults for the current runtime.

## UX Surfaces

- [x] Extend the TUI with mission/fleet/wallet visibility, approval flow for `host_exec`, and slash commands:
  `/mission`, `/explore`, `/budget`, `/wake`, `/lessons`.
- [x] Extend the CLI with `bakudo daemon` and `bakudo status`.
- [x] Keep the restored conversational host layer and route it into the new wake-based mission runtime instead of deleting it.

## Verification

- [x] Add or update tests for wake flow.
- [x] Add or update tests for mission persistence and crash/restart resume.
- [x] Add or update tests for blackboard updates and lessons/provenance persistence.
- [x] Add or update tests for wallet enforcement and multi-wave dispatch.
- [x] Add or update tests for host approvals and ask-user flow.
- [x] Finish with:
  `cargo test --workspace`
- [x] Finish with:
  `cargo clippy --workspace --all-targets -- -D warnings`
