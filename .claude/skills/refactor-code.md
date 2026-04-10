# Skill: Refactor Code in Bakudo

## Trigger

When asked to simplify, restructure, or improve code quality in the `bakudo` repository.

## Process

1.  **Establish a Baseline**: Run `pnpm test` to ensure the current codebase is in a stable state.
2.  **Make the Refactoring Changes**:
    - Identify areas for improvement in `src/`.
    - Maintain the existing TypeScript architecture (functional programming style).
    - Simplify logic where possible.
3.  **Verify the Changes**:
    - Run `pnpm test` again to ensure no regressions were introduced.
4.  **Run Quality Checks**:
    - Run `just check` to verify linting, tests, and build.
5.  **Commit**:
    - Use conventional commit messages (e.g., `refactor: simplify tool registration logic`).

## Quality Gate

Before every commit, run:

```bash
just check
```

All checks must pass with zero errors.
