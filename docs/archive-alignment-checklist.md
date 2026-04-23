# Archived Plan Alignment Checklist

Target spec: `docs/archive/bakudo-v2-architecture-and-implementation-plan.md`

Audit date: `2026-04-23`

The current Rust runtime is already materially aligned with the archived v2 plan in the areas below:

## Already Landed

- [x] Supervisor-style wake runtime layered through `SessionController` and the restored chat-first host path.
- [x] Durable mission persistence for `Mission`, `Experiment`, `WakeEvent`, wallet state, user messages, lessons, ledger entries, active waves, and restart resume.
- [x] Deliberator stdio runner with the planned MCP-style tool surface and `meta` sidecar.
- [x] Append-only mission provenance logging under `.bakudo/provenance/<mission-id>.ndjson`.
- [x] Mission and Explore postures, multi-wave dispatch, wallet enforcement, host approvals, ask-user flow, and restart coverage in `tests/runtime.rs`.
- [x] Provider/prompt materialisation into `.bakudo/providers/*.toml` and `.bakudo/prompts/*.md`.
- [x] TUI and CLI extensions for mission lifecycle, approvals, wake control, `bakudo daemon`, and `bakudo status`.
- [x] Preservation of the timeout-classification fix in `crates/bakudo-core/src/abox.rs`.

## Completed Cleanup

- [x] Replace the remaining public/runtime Mission State terminology drift:
  domain types, wake payload fields, tool names, prompts, docs, comments, and tests.
- [x] Rename persistence surfaces where practical to `mission_state`:
  mission store APIs, SQLite table names, and stored wake payload snapshots.
- [x] Remove transitional compatibility and migration code instead of preserving it:
  old wake field aliases, old tool aliases, old mission-state table migration, and old swarm-artifact path fallback.
- [x] Re-run and pass:
  `cargo test --workspace`
- [x] Re-run and pass:
  `cargo clippy --workspace --all-targets -- -D warnings`
