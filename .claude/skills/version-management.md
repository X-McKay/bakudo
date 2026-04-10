# Skill: Version Management in Bakudo

## Overview

`bakudo` follows a semantic versioning (SemVer) strategy to ensure clarity and compatibility for developers. This skill dictates how version numbers are determined and updated within the repository.

## Determining the Next Version

The version number in `package.json` consists of three parts: **Major**, **Minor**, and **Patch**. A **Major** version bump is required when there are breaking changes to the core harness API or configuration schema. A **Minor** version bump is used for new features that are backwards compatible, such as adding a new tool provider or a new orchestration strategy. A **Patch** version bump is reserved for backwards-compatible bug fixes and documentation updates.

## Automated Version Bumping Process

When preparing a release, the AI agent should first analyze the commit history since the last tag. If any commit starts with `feat:`, a **Minor** bump is recommended. If any commit includes `BREAKING CHANGE:`, a **Major** bump is required. Otherwise, a **Patch** bump is applied. To update the version, the agent should use `npm version <major|minor|patch> --no-git-tag-version` to modify `package.json` without creating a git tag immediately.

## Quality and Verification

After updating the version in `package.json`, the agent must run the full test suite using `pnpm test` and verify that the build is successful with `pnpm build`. This ensures that the new version is stable and ready for deployment. The updated `package.json` should then be committed with a message like `chore: bump version to vX.Y.Z`.

## Finalizing the Release

Once the version is bumped and verified on the `main` branch, a git tag should be created using `git tag vX.Y.Z`. The final step is to push the branch and the tags to the remote repository with `git push origin main --tags`.
