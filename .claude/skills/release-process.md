# Skill: AI-Based Release Process in Bakudo

## Trigger
When a feature branch is ready to be merged into `main` or when a new version of `bakudo` needs to be released.

## Branch Naming Conventions
*   **Feature Branches**: `feat/<short-description>`
*   **Bug Fixes**: `fix/<short-description>`
*   **Refactoring**: `refactor/<short-description>`
*   **Documentation**: `docs/<short-description>`

## Process for Feature Branch to Main
1.  **Preparation**:
    *   Ensure all code changes are committed on the feature branch.
    *   Run `just check` (or `pnpm lint && pnpm test && pnpm build`) to verify code quality.
2.  **Version Bumping**:
    *   Determine the version bump type:
        *   **Major**: Breaking changes.
        *   **Minor**: New features (backwards compatible).
        *   **Patch**: Bug fixes (backwards compatible).
    *   Update `package.json` with the new version.
3.  **Merge into Main**:
    *   Checkout `main` branch.
    *   Pull latest changes from `origin/main`.
    *   Merge the feature branch: `git merge <branch-name>`.
    *   If conflicts occur, resolve them and run `just check` again.
4.  **Final Quality Gate**:
    *   On `main` branch, run all tests: `pnpm test`.
    *   Verify linting: `pnpm lint`.
    *   Ensure build is successful: `pnpm build`.
5.  **Tagging and Pushing**:
    *   Create a git tag for the new version: `git tag v<version>`.
    *   Push to `origin/main` with tags: `git push origin main --tags`.

## AI-Driven Release Automation
AI agents should automate the following:
*   **Automatic Version Bumping**: Use tools to parse commit messages and determine the next version.
*   **Testing Requirement Enforcement**: Never merge if `pnpm test` fails.
*   **Documentation Update**: Automatically update `CHANGELOG.md` based on commit history.

## Quality Gate
*   Zero linting errors.
*   All tests (unit, integration, regression) pass.
*   Version in `package.json` is updated.
*   Branch naming convention is followed.
