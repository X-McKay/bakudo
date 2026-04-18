# bakudo Agent Conventions

## State Mutation Rules

All state mutations in the host runtime MUST use functional updaters:

```ts
// Always:
dispatch({ type: "set_mode", mode: "plan" });
// or for direct state:
deps.appState = reduceHost(deps.appState, action);
```

```ts
// Never:
deps.appState.composer.mode = "plan";
deps.appState = { ...deps.appState, status: "running" };
```

Rationale: concurrent-safe, replayable, testable. See Phase 2 spec
(2026-04-15 second-pass, Functional State Updates).

### Audit checklist

When modifying `src/host/**`:

1. Every `deps.appState = ...` assignment MUST use `reduceHost(deps.appState, action)`.
2. Never assign to a nested property of `appState` directly.
3. `deps.transcript.push(...)` is allowed — transcript is an append-only mutable log.
4. The reducer (`src/host/reducer.ts`) MUST remain a pure function: no side effects, always returns a new object via spread.
