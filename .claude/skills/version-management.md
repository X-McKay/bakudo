# Skill: Version Management in Bakudo

## Overview

Bakudo v2 follows Semantic Versioning (SemVer). The version is defined in
the workspace `Cargo.toml` and propagated to all member crates via
`cargo set-version`.

## Determining the Next Version

| Commit type | Version bump |
|-------------|-------------|
| `BREAKING CHANGE:` in footer | Major |
| `feat:` | Minor |
| `fix:`, `docs:`, `chore:`, `perf:`, `refactor:` | Patch |

## Automated Version Bump Process

1. Analyze the commit history since the last tag:
   ```bash
   git log $(git describe --tags --abbrev=0)..HEAD --oneline
   ```
2. Determine the bump type from the table above.
3. Apply the bump using `cargo-edit`:
   ```bash
   cargo set-version --bump <major|minor|patch>
   ```
4. Commit:
   ```bash
   git add Cargo.toml Cargo.lock crates/*/Cargo.toml
   git commit -m "chore: bump version to vX.Y.Z"
   ```

## Quality and Verification

After bumping the version, run `just check` to confirm the build is stable.

## Finalizing the Release

```bash
git tag vX.Y.Z
git push origin main --tags
```

See `.claude/skills/release-process.md` for the full release workflow.
