# Skill: Run Tests in Bakudo

## Trigger

When asked to verify the correctness of the `bakudo` repository or after making any code changes.

## Context

`bakudo` uses the Node.js native test runner and TypeScript. Tests are categorized into unit, integration, and regression tests.

## Process

1.  **Run All Tests**:

    ```bash
    pnpm test
    ```

    This command builds the project and runs all tests in the `tests/` directory.

2.  **Run Specific Test Categories**:
    - **Unit Tests**: `pnpm test:unit`
    - **Integration Tests**: `pnpm test:integration`
    - **Regression Tests**: `pnpm test:regression`

3.  **Interpret Results**:
    - All tests must pass (indicated by a green checkmark or "pass" count).
    - If a test fails, analyze the `AssertionError` and the input/expected values.
    - Common issues include type mismatches or incorrect property access on `MemoryStore`.

4.  **Add New Tests**:
    - **Unit Tests**: Place in `tests/unit/`. Focus on individual classes like `PolicyEngine`.
    - **Integration Tests**: Place in `tests/integration/`. Focus on end-to-end workflows.
    - **Regression Tests**: Place in `tests/regression/`. Always add a test for every bug fix, naming it `bug-<number>-<description>.test.ts`.

## Quality Gate

Ensure `pnpm build` passes before running tests. All tests must pass with zero failures.
