# Skill: Update the Policy Engine in Bakudo

## Trigger

When changing how the agent's autonomy budgets or tool allowlists are evaluated in the `bakudo` repository.

## Process

1.  **Analyze the Requirement**: Understand the policy change (e.g., adding a new tool to an allowlist, updating a budget threshold).
2.  **Design the Change**:
    - Read `src/policy.ts` and `src/models.ts` to understand the current policy model.
    - Update the `Policy` or `Budget` types in `src/models.ts` if the schema changed.
    - Make changes to the `PolicyEngine` in `src/policy.ts`.
3.  **Update Configuration**:
    - Update `config/default.json` if the policy schema changed.
4.  **Write Tests**:
    - Add or update tests in `tests/harness.test.ts` to verify the new policy evaluation logic.
5.  **Run Quality Checks**:
    - Run `just check` to ensure everything passes.
6.  **Commit**:
    - Use conventional commit messages (e.g., `feat: update policy to allow file tool in build mode`).

## Quality Gate

Before every commit, run:

```bash
just check
```

All checks must pass with zero errors.
