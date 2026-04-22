# Skill: Refactor Code in Bakudo

## Trigger

When asked to refactor, simplify, or restructure code in the `bakudo`
repository without changing external behaviour.

## Process

1. **Ensure tests pass before starting:**
   ```bash
   cargo test --workspace
   ```
   Capture the passing test count as the baseline.

2. **Apply the refactor.** Common patterns in this codebase:
   - Extract repeated abox argument construction into a helper in
     `bakudo-core/src/abox.rs`.
   - Move shared types between daemon and TUI into `bakudo-core`.
   - Replace `unwrap()` with proper error propagation using `?` and
     `BakudoError`.
   - Replace `Arc<Mutex<T>>` with `Arc<tokio::sync::Mutex<T>>` for
     async-safe shared state.

3. **Run the quality gate after every logical change:**
   ```bash
   just check
   ```
   Fix any new clippy warnings immediately — do not accumulate them.

4. **Verify behaviour is unchanged:**
   ```bash
   cargo test --workspace
   ```
   The same tests that passed before must still pass, with the same count.

5. **Commit** using Conventional Commits:
   ```
   refactor(<scope>): <description>
   ```

## Quality Gate

`just check` must pass with zero errors and zero warnings, and the test
count must not decrease.
