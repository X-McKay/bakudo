# Skill: Fix a Bug in Bakudo

## Trigger

When asked to fix a bug or failing test in the `bakudo` repository.

## Process

1.  **Reproduce the Bug**: Write a failing test in `tests/` that demonstrates the issue.
2.  **Fix the Code**:
    - Identify the root cause in the TypeScript codebase.
    - Make the minimal change needed to fix the bug.
    - Ensure the change does not introduce any regressions.
3.  **Verify the Fix**:
    - Run `pnpm test` to ensure the new test passes and no existing tests regress.
4.  **Run Quality Checks**:
    - Run `just check` to verify linting, tests, and build.
5.  **Commit**:
    - Use conventional commit messages (e.g., `fix: resolve race condition in orchestrator loop`).

## Quality Gate

Before every commit, run:

```bash
just check
```

All checks must pass with zero errors.
