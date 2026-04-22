# Skill: Release Process for Bakudo

## Trigger

When asked to prepare or cut a release of `bakudo`.

## Process

1. **Ensure the branch is clean and all tests pass:**
   ```bash
   git checkout main && git pull
   just check
   ```

2. **Determine the next version** using Semantic Versioning:
   - `BREAKING CHANGE:` in any commit footer -> major bump.
   - Any `feat:` commit -> minor bump.
   - Only `fix:`, `docs:`, `chore:` commits -> patch bump.

3. **Update `CHANGELOG.md`** with a new section for the version:
   ```markdown
   ## [X.Y.Z] — YYYY-MM-DD
   ### Added
   - ...
   ### Fixed
   - ...
   ### Changed
   - ...
   ```

4. **Bump the version** in all `Cargo.toml` files. Install `cargo-edit`
   if not present (`cargo install cargo-edit`), then:
   ```bash
   cargo set-version X.Y.Z
   ```
   This updates the workspace root and all member crates.

5. **Commit the version bump:**
   ```bash
   git add Cargo.toml Cargo.lock crates/*/Cargo.toml CHANGELOG.md
   git commit -m "chore: bump version to vX.Y.Z"
   ```

6. **Tag the release:**
   ```bash
   git tag vX.Y.Z
   ```

7. **Push branch and tag:**
   ```bash
   git push origin main --tags
   ```

8. **Build the release binary:**
   ```bash
   cargo build --release
   ```
   The binary is at `target/release/bakudo`.

9. **Create the GitHub release** and attach the binary.

## Quality Gate

`just check` must pass on `main` before tagging. Never tag a commit that
has failing tests or clippy warnings.
