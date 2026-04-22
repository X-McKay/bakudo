# Skill: Bug Fix in Bakudo

## Trigger

When asked to fix a bug in the `bakudo` repository.

## Process

1. **Reproduce the bug.** Write a failing test in the relevant crate
   (`cargo test -p <crate>`) or in `tests/integration.rs` that demonstrates
   the incorrect behaviour.

2. **Locate the root cause.** Use `cargo check`, `cargo clippy`, and the
   failing test output to narrow down the source. Check `AGENTS.md` for
   architecture invariants that may have been violated.

3. **Fix the bug.** Apply the minimal change necessary. Do not refactor
   unrelated code in the same commit.

4. **Verify the fix:**
   ```bash
   just check
   ```
   The previously failing test must now pass, and no new warnings may be
   introduced.

5. **Commit** using Conventional Commits:
   ```
   fix(<scope>): <description of what was wrong and what was fixed>
   ```

## Quality Gate

`just check` must pass with zero errors and zero warnings.
