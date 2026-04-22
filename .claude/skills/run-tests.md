# Skill: Run Tests in Bakudo

## Trigger

When asked to verify the correctness of the `bakudo` repository or after
making any code changes.

## Context

Bakudo v2 uses Rust's built-in test framework. Tests live in two places:
- **Crate-level unit tests**: `#[cfg(test)]` modules inside each crate's
  source files (e.g., `crates/bakudo-core/src/provider.rs`).
- **Workspace integration tests**: `tests/integration.rs` at the repo root.

## Process

1. **Run all tests:**
   ```bash
   cargo test --workspace
   ```

2. **Run tests for a specific crate:**
   ```bash
   cargo test -p bakudo-core
   cargo test -p bakudo-daemon
   cargo test -p bakudo-tui
   ```

3. **Run a specific test by name:**
   ```bash
   cargo test -p bakudo-core abox::tests::parse_list_with_entries
   ```

4. **Run integration tests only:**
   ```bash
   cargo test --test integration
   ```

5. **Interpret results.** All tests must pass. If a test fails, read the
   assertion error carefully — it will show the expected vs. actual value.
   Common issues: incorrect argument order in abox adapter calls, wrong
   provider flag strings, or stale ledger state in async tests.

6. **Add new tests.** Unit tests go in the relevant source file under
   `#[cfg(test)]`. Integration tests go in `tests/integration.rs` in a
   clearly named module (e.g., `mod provider_registry_tests`).

## Quality Gate

`cargo test --workspace` must pass with zero failures before every commit.
