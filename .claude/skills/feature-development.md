# Skill: Implement a New Feature in Bakudo

## Trigger

When asked to add new functionality to the `bakudo` agent harness.

## Context

`bakudo` is a lightweight, robust custom agent harness designed for high-autonomy operation using `abox` sandboxing. It is written in TypeScript and follows a functional programming style to ensure testability.

## Process

1.  **Analyze the Requirement**: Understand the goal and identify which component of the harness needs modification (`orchestrator`, `tools`, `adapter`, `policy`, etc.).
2.  **Design the Change**:
    - Follow the **Planner → Executor contract** for any new step-based functionality.
    - Maintain **Mode-aware policy** by updating the tool allowlists if necessary.
    - Ensure any new external interaction is handled via an adapter or a tool.
3.  **Implement the Feature**:
    - Use TypeScript best practices.
    - Keep the core lightweight (minimize runtime dependencies).
    - Follow the existing coding style (ESLint and Prettier).
4.  **Write Tests**:
    - Add unit tests in `tests/` for the new functionality.
    - Ensure the feature is independently testable in isolation.
5.  **Run Quality Checks**:
    - Run `just check` to ensure linting, tests, and build all pass.
6.  **Commit**:
    - Use conventional commit messages (e.g., `feat: add support for MCP tool providers`).

## Quality Gate

Before every commit, run:

```bash
just check
```

This command runs `lint`, `test`, and `build`. All must pass with zero errors.
