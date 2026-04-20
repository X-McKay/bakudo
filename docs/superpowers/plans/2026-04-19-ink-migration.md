# Ink Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate bakudo's interactive TUI from the custom-ANSI `TtyBackend` to an Ink-based component tree, move the turn pipeline into a `<TurnDriver/>` React effect, and land the P1 composer polish. `PlainBackend` + `JsonBackend` unchanged.

**Architecture:** External `createHostStore` wraps the existing `reduceHost`. React subscribes via `useSyncExternalStore`. One `<App/>` mount; redraws come from state updates. `<Composer/>` owns stdin via `useInput`; submits flow through the store. `<TurnDriver/>` runs the existing pipeline (`registry.dispatch` → `executePromptFromResolution`) as a `useEffect` async generator.

**Tech Stack:** TypeScript, Ink 7, React 19, `ink-testing-library`, `node:test`.

**Reference spec:** `docs/superpowers/specs/2026-04-19-ink-migration-design.md`.

**Working directory convention:** Every bash command in this plan runs with cwd = `/home/al/git/bakudo-abox/bakudo` (the bakudo package root). Paths below are relative to that root.

---

## Phase 1 — Store + state model (commit 1)

**Outcome of this phase:** `createHostStore` exists; `transcript` lives in `HostAppState`; reducer understands new actions; `interactive.ts` still drives the readline loop but reads/writes through the store; all tests green; no visual change.

---

### Task 1.1: Add `transcript` + new fields to `HostAppState`

**Files:**
- Modify: `src/host/appState.ts`

- [ ] **Step 1: Add a failing test**

Write to `tests/unit/appState.test.ts` (create if missing):

```typescript
import assert from "node:assert/strict";
import test from "node:test";
import { initialHostAppState } from "../../src/host/appState.js";

test("initialHostAppState: transcript starts empty", () => {
  const state = initialHostAppState();
  assert.deepEqual(state.transcript, []);
});

test("initialHostAppState: composer defaults include metadata fields", () => {
  const state = initialHostAppState();
  assert.equal(state.composer.model, "");
  assert.equal(state.composer.agent, "");
  assert.equal(state.composer.provider, "");
});

test("initialHostAppState: dispatch starts idle", () => {
  const state = initialHostAppState();
  assert.deepEqual(state.dispatch, { inFlight: false });
});

test("initialHostAppState: pendingSubmit and shouldExit are unset", () => {
  const state = initialHostAppState();
  assert.equal(state.pendingSubmit, undefined);
  assert.equal(state.shouldExit, undefined);
});
```

- [ ] **Step 2: Run the test, expect fail**

```bash
pnpm build && node --test dist/tests/unit/appState.test.js
```

Expected: 4 failures ("transcript is undefined", etc).

- [ ] **Step 3: Extend `HostAppState` + `initialHostAppState`**

In `src/host/appState.ts`, update the `HostAppState` type and initializer. Import `TranscriptItem` from `./renderModel.js` at the top:

```typescript
import type { TranscriptItem } from "./renderModel.js";
```

Update `HostAppState`:

```typescript
export type DispatchState =
  | { inFlight: false }
  | { inFlight: true; startedAt: number; label: string; detail?: string };

export type PendingSubmit = { seq: number; text: string };
export type ShouldExit = { code: number };

export type HostAppState = {
  screen: HostScreen;
  composer: {
    mode: ComposerMode;
    autoApprove: boolean;
    text: string;
    model: string;
    agent: string;
    provider: string;
  };
  activeSessionId?: string;
  activeTurnId?: string;
  inspect: InspectState;
  promptQueue: ReadonlyArray<PromptEntry>;
  notices: string[];
  approvalDialogCursor: number;
  quickHelp?: QuickHelpPayload;
  transcript: ReadonlyArray<TranscriptItem>;
  dispatch: DispatchState;
  pendingSubmit?: PendingSubmit;
  shouldExit?: ShouldExit;
};
```

Update `initialHostAppState`:

```typescript
export const initialHostAppState = (): HostAppState => ({
  screen: "transcript",
  composer: { mode: "standard", autoApprove: false, text: "", model: "", agent: "", provider: "" },
  inspect: {
    tab: "summary",
    scrollOffset: 0,
    scrollHeight: DEFAULT_INSPECT_SCROLL_HEIGHT,
  },
  promptQueue: [],
  notices: [],
  approvalDialogCursor: 0,
  transcript: [],
  dispatch: { inFlight: false },
});
```

- [ ] **Step 4: Run test, expect pass**

```bash
pnpm build && node --test dist/tests/unit/appState.test.js
```

Expected: 4 passes.

- [ ] **Step 5: Run full suite — catch type break-ages**

```bash
pnpm test 2>&1 | tail -20
```

Expected: tests fail in files that read `deps.transcript` or `deps.appState.composer`. Fix compile errors only; test failures are addressed in next tasks.

- [ ] **Step 6: Commit**

```bash
git add src/host/appState.ts tests/unit/appState.test.ts
git commit -m "feat(host): extend HostAppState with transcript + composer metadata + dispatch"
```

---

### Task 1.2: Extend reducer with transcript actions

**Files:**
- Modify: `src/host/reducer.ts`
- Test: `tests/unit/reducer.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `tests/unit/reducer.test.ts`:

```typescript
import assert from "node:assert/strict";
import test from "node:test";
import { reduceHost } from "../../src/host/reducer.js";
import { initialHostAppState } from "../../src/host/appState.js";

test("reducer: append_user adds a user transcript item", () => {
  const s0 = initialHostAppState();
  const s1 = reduceHost(s0, { type: "append_user", text: "hi" });
  assert.deepEqual(s1.transcript, [{ kind: "user", text: "hi" }]);
});

test("reducer: append_assistant adds an assistant item with tone", () => {
  const s0 = initialHostAppState();
  const s1 = reduceHost(s0, { type: "append_assistant", text: "done", tone: "success" });
  assert.deepEqual(s1.transcript, [{ kind: "assistant", text: "done", tone: "success" }]);
});

test("reducer: append_event adds an event item", () => {
  const s0 = initialHostAppState();
  const s1 = reduceHost(s0, { type: "append_event", label: "version", detail: "bakudo 0.2.0" });
  assert.deepEqual(s1.transcript, [{ kind: "event", label: "version", detail: "bakudo 0.2.0" }]);
});

test("reducer: append_output adds an output block", () => {
  const s0 = initialHostAppState();
  const s1 = reduceHost(s0, { type: "append_output", text: "line1\nline2" });
  assert.deepEqual(s1.transcript, [{ kind: "output", text: "line1\nline2" }]);
});

test("reducer: append_review adds a review card", () => {
  const s0 = initialHostAppState();
  const s1 = reduceHost(s0, {
    type: "append_review",
    outcome: "success",
    summary: "ok",
    nextAction: "continue",
  });
  assert.deepEqual(s1.transcript, [
    { kind: "review", outcome: "success", summary: "ok", nextAction: "continue" },
  ]);
});

test("reducer: clear_transcript empties the transcript", () => {
  const s0 = reduceHost(initialHostAppState(), { type: "append_user", text: "hi" });
  const s1 = reduceHost(s0, { type: "clear_transcript" });
  assert.deepEqual(s1.transcript, []);
});
```

- [ ] **Step 2: Run, expect fail**

```bash
pnpm build && node --test dist/tests/unit/reducer.test.js 2>&1 | grep -E "^(not ok|# pass|# fail)"
```

Expected: 6 new failures (action types unknown).

- [ ] **Step 3: Extend reducer**

In `src/host/reducer.ts`, add to the `HostAction` union:

```typescript
  | { type: "append_user"; text: string; timestamp?: string }
  | { type: "append_assistant"; text: string; tone?: "info" | "success" | "warning" | "error" }
  | { type: "append_event"; label: string; detail?: string }
  | { type: "append_output"; text: string }
  | {
      type: "append_review";
      outcome: string;
      summary: string;
      nextAction?: string;
    }
  | { type: "clear_transcript" }
```

In the `reduceHost` switch, add cases (place near other content-mutation cases):

```typescript
    case "append_user": {
      const item = action.timestamp === undefined
        ? { kind: "user" as const, text: action.text }
        : { kind: "user" as const, text: action.text, timestamp: action.timestamp };
      return { ...state, transcript: [...state.transcript, item] };
    }
    case "append_assistant": {
      const item = action.tone === undefined
        ? { kind: "assistant" as const, text: action.text }
        : { kind: "assistant" as const, text: action.text, tone: action.tone };
      return { ...state, transcript: [...state.transcript, item] };
    }
    case "append_event": {
      const item = action.detail === undefined
        ? { kind: "event" as const, label: action.label }
        : { kind: "event" as const, label: action.label, detail: action.detail };
      return { ...state, transcript: [...state.transcript, item] };
    }
    case "append_output":
      return {
        ...state,
        transcript: [...state.transcript, { kind: "output", text: action.text }],
      };
    case "append_review": {
      const item = action.nextAction === undefined
        ? { kind: "review" as const, outcome: action.outcome, summary: action.summary }
        : {
            kind: "review" as const,
            outcome: action.outcome,
            summary: action.summary,
            nextAction: action.nextAction,
          };
      return { ...state, transcript: [...state.transcript, item] };
    }
    case "clear_transcript":
      return { ...state, transcript: [] };
```

- [ ] **Step 4: Run, expect pass**

```bash
pnpm build && node --test dist/tests/unit/reducer.test.js 2>&1 | grep -E "^# (pass|fail)"
```

Expected: 6 new passes, 0 new failures.

- [ ] **Step 5: Commit**

```bash
git add src/host/reducer.ts tests/unit/reducer.test.ts
git commit -m "feat(host): reducer actions for transcript mutation"
```

---

### Task 1.3: Extend reducer with dispatch / submit / exit actions

**Files:**
- Modify: `src/host/reducer.ts`
- Test: `tests/unit/reducer.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `tests/unit/reducer.test.ts`:

```typescript
test("reducer: dispatch_started sets inflight with label", () => {
  const s0 = initialHostAppState();
  const s1 = reduceHost(s0, { type: "dispatch_started", label: "Routing", startedAt: 1000 });
  assert.equal(s1.dispatch.inFlight, true);
  if (s1.dispatch.inFlight) {
    assert.equal(s1.dispatch.label, "Routing");
    assert.equal(s1.dispatch.startedAt, 1000);
  }
});

test("reducer: dispatch_progress updates detail without clearing", () => {
  const s0 = reduceHost(initialHostAppState(), {
    type: "dispatch_started",
    label: "Working",
    startedAt: 1000,
  });
  const s1 = reduceHost(s0, { type: "dispatch_progress", detail: "compiling" });
  assert.equal(s1.dispatch.inFlight, true);
  if (s1.dispatch.inFlight) {
    assert.equal(s1.dispatch.detail, "compiling");
    assert.equal(s1.dispatch.label, "Working");
  }
});

test("reducer: dispatch_finished resets to idle", () => {
  const s0 = reduceHost(initialHostAppState(), {
    type: "dispatch_started",
    label: "Routing",
    startedAt: 1000,
  });
  const s1 = reduceHost(s0, { type: "dispatch_finished" });
  assert.deepEqual(s1.dispatch, { inFlight: false });
});

test("reducer: submit sets pendingSubmit with monotonic seq", () => {
  const s0 = initialHostAppState();
  const s1 = reduceHost(s0, { type: "submit", text: "hello" });
  assert.equal(s1.pendingSubmit?.text, "hello");
  assert.equal(s1.pendingSubmit?.seq, 1);
  const s2 = reduceHost(s1, { type: "submit", text: "again" });
  assert.equal(s2.pendingSubmit?.seq, 2);
});

test("reducer: clear_pending_submit unsets pendingSubmit", () => {
  const s0 = reduceHost(initialHostAppState(), { type: "submit", text: "x" });
  const s1 = reduceHost(s0, { type: "clear_pending_submit" });
  assert.equal(s1.pendingSubmit, undefined);
});

test("reducer: request_exit sets shouldExit", () => {
  const s0 = initialHostAppState();
  const s1 = reduceHost(s0, { type: "request_exit", code: 0 });
  assert.deepEqual(s1.shouldExit, { code: 0 });
});

test("reducer: set_composer_metadata updates model/agent/provider", () => {
  const s0 = initialHostAppState();
  const s1 = reduceHost(s0, {
    type: "set_composer_metadata",
    model: "sonnet-4.6",
    agent: "default",
    provider: "claude",
  });
  assert.equal(s1.composer.model, "sonnet-4.6");
  assert.equal(s1.composer.agent, "default");
  assert.equal(s1.composer.provider, "claude");
});
```

- [ ] **Step 2: Run, expect fail**

```bash
pnpm build && node --test dist/tests/unit/reducer.test.js 2>&1 | grep -E "^(# pass|# fail)"
```

Expected: new failures totaling 7.

- [ ] **Step 3: Extend reducer**

Add to `HostAction` union in `src/host/reducer.ts`:

```typescript
  | { type: "dispatch_started"; label: string; startedAt: number; detail?: string }
  | { type: "dispatch_progress"; detail?: string; label?: string }
  | { type: "dispatch_finished" }
  | { type: "submit"; text: string }
  | { type: "clear_pending_submit" }
  | { type: "request_exit"; code: number }
  | {
      type: "set_composer_metadata";
      model?: string;
      agent?: string;
      provider?: string;
    }
```

Above `reduceHost`, add a monotonic seq counter kept inside the reducer module:

```typescript
let submitSeqCounter = 0;
```

Inside `reduceHost`, add cases:

```typescript
    case "dispatch_started":
      return {
        ...state,
        dispatch: {
          inFlight: true,
          startedAt: action.startedAt,
          label: action.label,
          ...(action.detail !== undefined ? { detail: action.detail } : {}),
        },
      };
    case "dispatch_progress":
      if (!state.dispatch.inFlight) return state;
      return {
        ...state,
        dispatch: {
          ...state.dispatch,
          ...(action.label !== undefined ? { label: action.label } : {}),
          ...(action.detail !== undefined ? { detail: action.detail } : {}),
        },
      };
    case "dispatch_finished":
      return { ...state, dispatch: { inFlight: false } };
    case "submit":
      submitSeqCounter += 1;
      return { ...state, pendingSubmit: { seq: submitSeqCounter, text: action.text } };
    case "clear_pending_submit": {
      const { pendingSubmit: _drop, ...rest } = state;
      return rest as HostAppState;
    }
    case "request_exit":
      return { ...state, shouldExit: { code: action.code } };
    case "set_composer_metadata":
      return {
        ...state,
        composer: {
          ...state.composer,
          ...(action.model !== undefined ? { model: action.model } : {}),
          ...(action.agent !== undefined ? { agent: action.agent } : {}),
          ...(action.provider !== undefined ? { provider: action.provider } : {}),
        },
      };
```

- [ ] **Step 4: Run, expect pass**

```bash
pnpm build && node --test dist/tests/unit/reducer.test.js 2>&1 | tail -5
```

Expected: 7 new passes.

- [ ] **Step 5: Commit**

```bash
git add src/host/reducer.ts tests/unit/reducer.test.ts
git commit -m "feat(host): reducer actions for dispatch lifecycle + submit/exit"
```

---

### Task 1.4: Create `createHostStore`

**Files:**
- Create: `src/host/store/index.ts`
- Test: `tests/unit/host/store.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/unit/host/store.test.ts`:

```typescript
import assert from "node:assert/strict";
import test from "node:test";
import { initialHostAppState } from "../../../src/host/appState.js";
import { reduceHost } from "../../../src/host/reducer.js";
import { createHostStore } from "../../../src/host/store/index.js";

test("createHostStore: getSnapshot returns initial state", () => {
  const store = createHostStore(reduceHost, initialHostAppState());
  assert.equal(store.getSnapshot().screen, "transcript");
});

test("createHostStore: dispatch advances state via reducer", () => {
  const store = createHostStore(reduceHost, initialHostAppState());
  store.dispatch({ type: "append_user", text: "hi" });
  assert.deepEqual(store.getSnapshot().transcript, [{ kind: "user", text: "hi" }]);
});

test("createHostStore: subscribe fires on state change", () => {
  const store = createHostStore(reduceHost, initialHostAppState());
  let calls = 0;
  const unsubscribe = store.subscribe(() => {
    calls += 1;
  });
  store.dispatch({ type: "append_user", text: "hi" });
  store.dispatch({ type: "append_user", text: "bye" });
  assert.equal(calls, 2);
  unsubscribe();
  store.dispatch({ type: "append_user", text: "ignored" });
  assert.equal(calls, 2);
});

test("createHostStore: getSnapshot returns same reference when no change", () => {
  const store = createHostStore(reduceHost, initialHostAppState());
  const first = store.getSnapshot();
  // Dispatch an action that doesn't change state (unknown-but-typed path).
  // `clear_notices` on empty notices yields an equal-shape but new object;
  // use a no-op: dispatch_progress with no inflight returns state unchanged.
  store.dispatch({ type: "dispatch_progress", detail: "x" });
  assert.strictEqual(store.getSnapshot(), first);
});
```

- [ ] **Step 2: Run, expect fail**

```bash
pnpm build && node --test dist/tests/unit/host/store.test.js 2>&1 | tail -10
```

Expected: module-not-found error.

- [ ] **Step 3: Implement `createHostStore`**

Create `src/host/store/index.ts`:

```typescript
import type { HostAppState } from "../appState.js";
import type { HostAction } from "../reducer.js";

export type Reducer = (state: HostAppState, action: HostAction) => HostAppState;
export type Subscriber = () => void;

export type HostStore = {
  getSnapshot(): HostAppState;
  subscribe(fn: Subscriber): () => void;
  dispatch(action: HostAction): void;
};

export const createHostStore = (
  reducer: Reducer,
  initialState: HostAppState,
): HostStore => {
  let state = initialState;
  const subscribers = new Set<Subscriber>();

  return {
    getSnapshot: () => state,
    subscribe: (fn) => {
      subscribers.add(fn);
      return () => {
        subscribers.delete(fn);
      };
    },
    dispatch: (action) => {
      const next = reducer(state, action);
      if (next === state) return;
      state = next;
      for (const fn of subscribers) fn();
    },
  };
};
```

Note the reducer must return `state` unchanged on no-op actions for the reference-equality test to hold. Verify `dispatch_progress` with `!state.dispatch.inFlight` returns `state` (not a shallow-copy) in `reducer.ts` — it already does from Task 1.3.

- [ ] **Step 4: Run, expect pass**

```bash
pnpm build && node --test dist/tests/unit/host/store.test.js 2>&1 | tail -10
```

Expected: 4 passes.

- [ ] **Step 5: Commit**

```bash
git add src/host/store/index.ts tests/unit/host/store.test.ts
git commit -m "feat(host): createHostStore — subscribe/getSnapshot/dispatch wrapper"
```

---

### Task 1.5: Wire `interactive.ts` to use the store (keep readline)

**Files:**
- Modify: `src/host/interactive.ts`

- [ ] **Step 1: Read the current shape**

```bash
grep -n "deps\.transcript\|deps\.appState" src/host/interactive.ts | head -20
```

Identify every `deps.transcript.push(item)` and `deps.appState = ...` call.

- [ ] **Step 2: Construct the store at boot**

Inside `runInteractiveShell()` in `src/host/interactive.ts`, after `loadConfigCascade(...)`, add:

```typescript
import { createHostStore } from "./store/index.js";
import { reduceHost } from "./reducer.js";

// …existing code up to `const deps: TickDeps = {...}`

const store = createHostStore(reduceHost, initialHostAppState());

const deps: TickDeps = {
  // Facade: transcript becomes a proxy whose .push dispatches an action.
  // getter returns the store's current slice.
  get transcript() {
    return store.getSnapshot().transcript as TranscriptItem[];
  },
  set transcript(_items) {
    // Writes are not allowed through the facade — callers must dispatch.
    throw new Error("deps.transcript is read-through; use store.dispatch actions");
  },
  appState: store.getSnapshot(),
  repoLabel,
  config: configSnapshot.merged,
};
```

**Critical:** because ~30 handlers call `deps.transcript.push(item)`, the above facade is not enough on its own. Replace the getter so the returned array exposes a `.push` that dispatches:

```typescript
const transcriptFacade = {
  get items() { return store.getSnapshot().transcript; },
  push(item: TranscriptItem): number {
    const kindToAction = {
      user: (i: TranscriptItem & { kind: "user" }) =>
        ({ type: "append_user", text: i.text, ...(i.timestamp ? { timestamp: i.timestamp } : {}) } as const),
      assistant: (i: TranscriptItem & { kind: "assistant" }) =>
        ({ type: "append_assistant", text: i.text, ...(i.tone ? { tone: i.tone } : {}) } as const),
      event: (i: TranscriptItem & { kind: "event" }) =>
        ({ type: "append_event", label: i.label, ...(i.detail ? { detail: i.detail } : {}) } as const),
      output: (i: TranscriptItem & { kind: "output" }) =>
        ({ type: "append_output", text: i.text } as const),
      review: (i: TranscriptItem & { kind: "review" }) =>
        ({
          type: "append_review" as const,
          outcome: i.outcome,
          summary: i.summary,
          ...(i.nextAction ? { nextAction: i.nextAction } : {}),
        }),
    } as const;
    const action = kindToAction[item.kind](item as never);
    store.dispatch(action);
    return store.getSnapshot().transcript.length;
  },
  // Expose read methods that code might use.
  get length() { return store.getSnapshot().transcript.length; },
  [Symbol.iterator]() { return store.getSnapshot().transcript[Symbol.iterator](); },
};
```

Then pass `transcriptFacade as unknown as TranscriptItem[]` into `deps.transcript` (TypeScript coercion; the real shape is richer than the handlers need).

- [ ] **Step 3: Rewrite every `deps.appState = reduceHost(...)` site to dispatch**

```bash
grep -n "deps\.appState = reduceHost" src/host/interactive.ts
```

For each match, replace `deps.appState = reduceHost(deps.appState, action)` with `store.dispatch(action)` and read `deps.appState` from a getter (refactor `deps` to be `{ get appState() { return store.getSnapshot() } }`).

- [ ] **Step 4: Rebuild**

```bash
pnpm build 2>&1 | tail -20
```

Expected: compiles clean. Fix any type errors.

- [ ] **Step 5: Run the full suite**

```bash
pnpm test 2>&1 | tail -10
```

Expected: same pass count as before (the 3 pre-existing `pipeline.test.ts` / `mergeController.test.ts` failures remain; nothing new fails).

- [ ] **Step 6: Smoke-test the shell**

```bash
pnpm install:cli && tui-use start --cwd /tmp --cols 140 --rows 40 bakudo && tui-use wait 1500
tui-use type "/version" && tui-use press enter && tui-use wait 1500
tui-use snapshot
tui-use kill
```

Expected: output identical to today's.

- [ ] **Step 7: Commit**

```bash
git add src/host/interactive.ts
git commit -m "refactor(host): route interactive deps through createHostStore"
```

---

## Phase 2 — Ink backend stub (commit 2)

**Outcome:** Ink renders the current frame with visual parity. `TtyBackend` deleted. Input still via readline (fixed in Phase 3). All tests green.

---

### Task 2.1: Add Ink + React deps and tsconfig JSX

**Files:**
- Modify: `package.json`, `tsconfig.json`

- [ ] **Step 1: Install deps**

```bash
pnpm add ink@^7 react@^19
pnpm add -D ink-testing-library @types/react
```

- [ ] **Step 2: Verify versions**

```bash
node -e "console.log(require('./node_modules/ink/package.json').version, require('./node_modules/react/package.json').version)"
```

Expected: Ink ≥ 7.0.1, React ≥ 19.x.

- [ ] **Step 3: Update `tsconfig.json`**

Add to `compilerOptions`:

```json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "react"
  }
}
```

- [ ] **Step 4: Verify build passes**

```bash
pnpm build 2>&1 | tail -5
```

Expected: compiles clean.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml tsconfig.json
git commit -m "build: add ink 7 + react 19 + ink-testing-library; enable JSX"
```

---

### Task 2.2: `useAppState` hook + `StoreProvider`

**Files:**
- Create: `src/host/renderers/ink/StoreProvider.tsx`
- Create: `src/host/renderers/ink/hooks/useAppState.ts`
- Test: `tests/unit/host/renderers/ink/useAppState.test.tsx`

- [ ] **Step 1: Write failing test**

Create `tests/unit/host/renderers/ink/useAppState.test.tsx`:

```typescript
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { initialHostAppState } from "../../../../../src/host/appState.js";
import { reduceHost } from "../../../../../src/host/reducer.js";
import { createHostStore } from "../../../../../src/host/store/index.js";
import { StoreProvider } from "../../../../../src/host/renderers/ink/StoreProvider.js";
import { useAppState } from "../../../../../src/host/renderers/ink/hooks/useAppState.js";

test("useAppState: reads initial state slice", () => {
  const store = createHostStore(reduceHost, initialHostAppState());
  const Probe = () => <Text>{useAppState((s) => s.screen)}</Text>;
  const { lastFrame } = render(
    <StoreProvider store={store}>
      <Probe />
    </StoreProvider>,
  );
  assert.equal(lastFrame(), "transcript");
});

test("useAppState: re-renders on dispatch", () => {
  const store = createHostStore(reduceHost, initialHostAppState());
  const Probe = () => <Text>{useAppState((s) => s.transcript.length.toString())}</Text>;
  const { lastFrame, rerender } = render(
    <StoreProvider store={store}>
      <Probe />
    </StoreProvider>,
  );
  assert.equal(lastFrame(), "0");
  store.dispatch({ type: "append_user", text: "hi" });
  // Give react a microtask to flush.
  rerender(
    <StoreProvider store={store}>
      <Probe />
    </StoreProvider>,
  );
  assert.equal(lastFrame(), "1");
});
```

- [ ] **Step 2: Run, expect fail (module not found)**

```bash
pnpm build && node --test dist/tests/unit/host/renderers/ink/useAppState.test.js 2>&1 | tail -5
```

- [ ] **Step 3: Implement `StoreProvider`**

Create `src/host/renderers/ink/StoreProvider.tsx`:

```typescript
import React, { createContext, useContext, type ReactNode } from "react";
import type { HostStore } from "../../store/index.js";

const StoreContext = createContext<HostStore | null>(null);

export const StoreProvider = ({
  store,
  children,
}: {
  store: HostStore;
  children: ReactNode;
}) => <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;

export const useStore = (): HostStore => {
  const store = useContext(StoreContext);
  if (!store) throw new Error("useStore must be used inside StoreProvider");
  return store;
};
```

- [ ] **Step 4: Implement `useAppState`**

Create `src/host/renderers/ink/hooks/useAppState.ts`:

```typescript
import { useSyncExternalStore } from "react";
import type { HostAppState } from "../../../appState.js";
import { useStore } from "../StoreProvider.js";

export function useAppState<T>(selector: (s: HostAppState) => T): T {
  const store = useStore();
  return useSyncExternalStore(
    store.subscribe,
    () => selector(store.getSnapshot()),
    () => selector(store.getSnapshot()),
  );
}
```

- [ ] **Step 5: Run, expect pass**

```bash
pnpm build && node --test dist/tests/unit/host/renderers/ink/useAppState.test.js 2>&1 | tail -5
```

Expected: 2 passes.

- [ ] **Step 6: Commit**

```bash
git add src/host/renderers/ink/StoreProvider.tsx src/host/renderers/ink/hooks/useAppState.ts tests/unit/host/renderers/ink/useAppState.test.tsx
git commit -m "feat(ink): StoreProvider + useAppState hook"
```

---

### Task 2.3: `<Header/>` component (parity)

**Files:**
- Create: `src/host/renderers/ink/Header.tsx`
- Test: `tests/unit/host/renderers/ink/header.test.tsx`

- [ ] **Step 1: Write failing test**

Create `tests/unit/host/renderers/ink/header.test.tsx`:

```typescript
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { initialHostAppState } from "../../../../../src/host/appState.js";
import { reduceHost } from "../../../../../src/host/reducer.js";
import { createHostStore } from "../../../../../src/host/store/index.js";
import { StoreProvider } from "../../../../../src/host/renderers/ink/StoreProvider.js";
import { Header } from "../../../../../src/host/renderers/ink/Header.js";

test("Header: shows title, mode chip, session label", () => {
  const store = createHostStore(reduceHost, initialHostAppState());
  const { lastFrame } = render(
    <StoreProvider store={store}>
      <Header repoLabel="bakudo" />
    </StoreProvider>,
  );
  const frame = lastFrame() ?? "";
  assert.match(frame, /Bakudo/);
  assert.match(frame, /STD/);
  assert.match(frame, /new session/);
  assert.match(frame, /bakudo/);
});

test("Header: mode chip reflects composer.mode", () => {
  const store = createHostStore(reduceHost, initialHostAppState());
  store.dispatch({ type: "set_mode", mode: "plan" });
  const { lastFrame } = render(
    <StoreProvider store={store}>
      <Header />
    </StoreProvider>,
  );
  assert.match(lastFrame() ?? "", /PLAN/);
});
```

- [ ] **Step 2: Run, expect fail**

```bash
pnpm build && node --test dist/tests/unit/host/renderers/ink/header.test.js 2>&1 | tail -5
```

- [ ] **Step 3: Implement `<Header/>`**

Create `src/host/renderers/ink/Header.tsx`:

```typescript
import React from "react";
import { Box, Text } from "ink";
import { useAppState } from "./hooks/useAppState.js";
import { getActiveTheme } from "../../themes/index.js";

const modeChipColor = (mode: string, theme: ReturnType<typeof getActiveTheme>): string => {
  if (mode === "plan") return "cyan";
  if (mode === "autopilot") return "green";
  return "yellow";
};

const modeChipLabel = (mode: string): string => {
  if (mode === "plan") return " PLAN ";
  if (mode === "autopilot") return " AUTO ";
  return " STD ";
};

const truncateSession = (id: string | undefined, turn: string | undefined): string => {
  if (!id) return "new session";
  const stripped = id.startsWith("session-") ? id.slice("session-".length) : id;
  const short = stripped.length > 14 ? `${stripped.slice(0, 10)}…${stripped.slice(-3)}` : stripped;
  const sessionLabel = `session ${short}`;
  if (!turn) return sessionLabel;
  const turnMatch = /^turn-(.+)$/u.exec(turn);
  const turnLabel = turnMatch ? `turn ${turnMatch[1]}` : turn;
  return `${sessionLabel} / ${turnLabel}`;
};

export const Header = ({ repoLabel }: { repoLabel?: string }) => {
  const mode = useAppState((s) => s.composer.mode);
  const activeSessionId = useAppState((s) => s.activeSessionId);
  const activeTurnId = useAppState((s) => s.activeTurnId);
  const theme = getActiveTheme();
  const chipColor = modeChipColor(mode, theme);

  return (
    <Box flexDirection="row" gap={2}>
      <Text bold>Bakudo</Text>
      <Text color={chipColor} bold>{modeChipLabel(mode)}</Text>
      <Text dimColor>{truncateSession(activeSessionId, activeTurnId)}</Text>
      {repoLabel !== undefined ? <Text dimColor>{repoLabel}</Text> : null}
    </Box>
  );
};
```

- [ ] **Step 4: Run, expect pass**

```bash
pnpm build && node --test dist/tests/unit/host/renderers/ink/header.test.js 2>&1 | tail -5
```

Expected: 2 passes.

- [ ] **Step 5: Commit**

```bash
git add src/host/renderers/ink/Header.tsx tests/unit/host/renderers/ink/header.test.tsx
git commit -m "feat(ink): Header component"
```

---

### Task 2.4: Transcript item components + `<Transcript/>` (parity)

**Files:**
- Create: `src/host/renderers/ink/transcript/{UserMessage,AssistantMessage,EventLine,OutputBlock,ReviewCard}.tsx`
- Create: `src/host/renderers/ink/Transcript.tsx`
- Test: `tests/unit/host/renderers/ink/transcript.test.tsx`

- [ ] **Step 1: Write failing test**

Create `tests/unit/host/renderers/ink/transcript.test.tsx`:

```typescript
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { initialHostAppState } from "../../../../../src/host/appState.js";
import { reduceHost } from "../../../../../src/host/reducer.js";
import { createHostStore } from "../../../../../src/host/store/index.js";
import { StoreProvider } from "../../../../../src/host/renderers/ink/StoreProvider.js";
import { Transcript } from "../../../../../src/host/renderers/ink/Transcript.js";

const renderWithStore = (dispatches: Parameters<ReturnType<typeof createHostStore>["dispatch"]>[0][]) => {
  const store = createHostStore(reduceHost, initialHostAppState());
  for (const a of dispatches) store.dispatch(a);
  return render(
    <StoreProvider store={store}>
      <Transcript />
    </StoreProvider>,
  ).lastFrame() ?? "";
};

test("Transcript: user message renders with '›' gutter", () => {
  const frame = renderWithStore([{ type: "append_user", text: "hello" }]);
  assert.match(frame, /›.*hello/);
});

test("Transcript: assistant message renders with '•' gutter", () => {
  const frame = renderWithStore([{ type: "append_assistant", text: "ok", tone: "success" }]);
  assert.match(frame, /•.*ok/);
});

test("Transcript: event line renders kind icon + detail, no '· kind' prefix", () => {
  const frame = renderWithStore([{ type: "append_event", label: "version", detail: "bakudo 0.2.0" }]);
  assert.doesNotMatch(frame, /· version/);
  assert.match(frame, /bakudo 0\.2\.0/);
});

test("Transcript: output block renders multiline, indented", () => {
  const frame = renderWithStore([{ type: "append_output", text: "a\nb" }]);
  assert.match(frame, /  a/);
  assert.match(frame, /  b/);
});

test("Transcript: review card renders outcome + next action", () => {
  const frame = renderWithStore([
    { type: "append_review", outcome: "success", summary: "done", nextAction: "ship it" },
  ]);
  assert.match(frame, /success/);
  assert.match(frame, /done/);
  assert.match(frame, /ship it/);
});
```

- [ ] **Step 2: Run, expect fail**

```bash
pnpm build && node --test dist/tests/unit/host/renderers/ink/transcript.test.js 2>&1 | tail -10
```

- [ ] **Step 3: Implement item components**

Create `src/host/renderers/ink/transcript/UserMessage.tsx`:

```typescript
import React from "react";
import { Box, Text } from "ink";

export const UserMessage = ({ text }: { text: string }) => (
  <Box flexDirection="row">
    <Text dimColor>› </Text>
    <Text>{text}</Text>
  </Box>
);
```

Create `src/host/renderers/ink/transcript/AssistantMessage.tsx`:

```typescript
import React from "react";
import { Box, Text } from "ink";

type Tone = "info" | "success" | "warning" | "error" | undefined;

const toneColor = (tone: Tone): string | undefined => {
  if (tone === "success") return "green";
  if (tone === "warning") return "yellow";
  if (tone === "error") return "red";
  if (tone === "info") return "cyan";
  return undefined;
};

export const AssistantMessage = ({ text, tone }: { text: string; tone?: Tone }) => (
  <Box flexDirection="row">
    <Text dimColor>• </Text>
    <Text color={toneColor(tone)}>{text}</Text>
  </Box>
);
```

Create `src/host/renderers/ink/transcript/EventLine.tsx`:

```typescript
import React from "react";
import { Box, Text } from "ink";

const iconForLabel = (label: string): { symbol: string; color: string } => {
  if (/error|fail/i.test(label)) return { symbol: "✗", color: "red" };
  if (/warn/i.test(label)) return { symbol: "◈", color: "yellow" };
  if (/success|ok|done/i.test(label)) return { symbol: "✓", color: "green" };
  return { symbol: "✓", color: "cyan" };
};

export const EventLine = ({ label, detail }: { label: string; detail?: string }) => {
  const { symbol, color } = iconForLabel(label);
  return (
    <Box flexDirection="row">
      <Text color={color}>{symbol} </Text>
      <Text dimColor>{detail ?? label}</Text>
    </Box>
  );
};
```

Create `src/host/renderers/ink/transcript/OutputBlock.tsx`:

```typescript
import React from "react";
import { Box, Text } from "ink";

export const OutputBlock = ({ text }: { text: string }) => (
  <Box flexDirection="column">
    {text.split("\n").map((line, i) => (
      <Text key={i} dimColor>{`  ${line}`}</Text>
    ))}
  </Box>
);
```

Create `src/host/renderers/ink/transcript/ReviewCard.tsx`:

```typescript
import React from "react";
import { Box, Text } from "ink";

const outcomeSymbol = (outcome: string): { symbol: string; color: string } => {
  if (/success|completed|succeeded/i.test(outcome)) return { symbol: "✓", color: "green" };
  if (/fail|denied/i.test(outcome)) return { symbol: "✗", color: "red" };
  if (/running|reviewing/i.test(outcome)) return { symbol: "◆", color: "cyan" };
  return { symbol: "·", color: "white" };
};

export const ReviewCard = ({
  outcome,
  summary,
  nextAction,
}: {
  outcome: string;
  summary: string;
  nextAction?: string;
}) => {
  const { symbol, color } = outcomeSymbol(outcome);
  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text bold>Review: </Text>
        <Text color={color}>{symbol} </Text>
        <Text>{`${outcome} — ${summary}`}</Text>
      </Box>
      {nextAction ? (
        <Box flexDirection="row">
          <Text dimColor>{`  → ${nextAction}`}</Text>
        </Box>
      ) : null}
    </Box>
  );
};
```

Create `src/host/renderers/ink/Transcript.tsx`:

```typescript
import React from "react";
import { Box } from "ink";
import { useAppState } from "./hooks/useAppState.js";
import { UserMessage } from "./transcript/UserMessage.js";
import { AssistantMessage } from "./transcript/AssistantMessage.js";
import { EventLine } from "./transcript/EventLine.js";
import { OutputBlock } from "./transcript/OutputBlock.js";
import { ReviewCard } from "./transcript/ReviewCard.js";

export const Transcript = () => {
  const items = useAppState((s) => s.transcript);
  return (
    <Box flexDirection="column">
      {items.map((item, i) => {
        if (item.kind === "user") return <UserMessage key={i} text={item.text} />;
        if (item.kind === "assistant")
          return <AssistantMessage key={i} text={item.text} tone={item.tone} />;
        if (item.kind === "event")
          return <EventLine key={i} label={item.label} detail={item.detail} />;
        if (item.kind === "output") return <OutputBlock key={i} text={item.text} />;
        return (
          <ReviewCard
            key={i}
            outcome={item.outcome}
            summary={item.summary}
            nextAction={item.nextAction}
          />
        );
      })}
    </Box>
  );
};
```

- [ ] **Step 4: Run, expect pass**

```bash
pnpm build && node --test dist/tests/unit/host/renderers/ink/transcript.test.js 2>&1 | tail -5
```

Expected: 5 passes.

- [ ] **Step 5: Commit**

```bash
git add src/host/renderers/ink/transcript/ src/host/renderers/ink/Transcript.tsx tests/unit/host/renderers/ink/transcript.test.tsx
git commit -m "feat(ink): Transcript + item components"
```

---

### Task 2.5: `<Footer/>` (parity — static hints mirror today's)

**Files:**
- Create: `src/host/renderers/ink/Footer.tsx`
- Test: `tests/unit/host/renderers/ink/footer.test.tsx`

- [ ] **Step 1: Write failing test**

Create `tests/unit/host/renderers/ink/footer.test.tsx`:

```typescript
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { initialHostAppState } from "../../../../../src/host/appState.js";
import { reduceHost } from "../../../../../src/host/reducer.js";
import { createHostStore } from "../../../../../src/host/store/index.js";
import { StoreProvider } from "../../../../../src/host/renderers/ink/StoreProvider.js";
import { Footer } from "../../../../../src/host/renderers/ink/Footer.js";

test("Footer: default hints include new, resume, help", () => {
  const store = createHostStore(reduceHost, initialHostAppState());
  const { lastFrame } = render(
    <StoreProvider store={store}>
      <Footer />
    </StoreProvider>,
  );
  const frame = lastFrame() ?? "";
  assert.match(frame, /\[new\]/);
  assert.match(frame, /\[resume\]/);
  assert.match(frame, /\[help\]/);
});
```

- [ ] **Step 2: Run, expect fail**

```bash
pnpm build && node --test dist/tests/unit/host/renderers/ink/footer.test.js 2>&1 | tail -5
```

- [ ] **Step 3: Implement `<Footer/>`**

Create `src/host/renderers/ink/Footer.tsx`:

```typescript
import React from "react";
import { Box, Text } from "ink";
import { useAppState } from "./hooks/useAppState.js";

const hintsFor = (state: {
  screen: string;
  activeSessionId?: string;
  overlay?: { kind: string };
}): string[] => {
  if (state.screen === "inspect")
    return ["[Shift+Tab] tabs", "[↑/↓] scroll", "[?] help", "[Ctrl+C] exit"];
  if (state.activeSessionId) return ["[inspect]", "[inspect provenance]", "[new]", "[resume]"];
  return ["[new]", "[resume]", "[help]"];
};

export const Footer = () => {
  const screen = useAppState((s) => s.screen);
  const activeSessionId = useAppState((s) => s.activeSessionId);
  const hints = hintsFor({ screen, activeSessionId });
  return (
    <Box flexDirection="column">
      <Text dimColor>{"─".repeat(48)}</Text>
      <Text dimColor>{hints.join("  ")}</Text>
    </Box>
  );
};
```

- [ ] **Step 4: Run, expect pass**

```bash
pnpm build && node --test dist/tests/unit/host/renderers/ink/footer.test.js 2>&1 | tail -5
```

Expected: 1 pass.

- [ ] **Step 5: Commit**

```bash
git add src/host/renderers/ink/Footer.tsx tests/unit/host/renderers/ink/footer.test.tsx
git commit -m "feat(ink): Footer component (parity with TtyBackend hints)"
```

---

### Task 2.6: Minimal `<Composer/>` (parity — renders `> `)

**Files:**
- Create: `src/host/renderers/ink/Composer.tsx`

- [ ] **Step 1: Implement minimal composer**

Create `src/host/renderers/ink/Composer.tsx` (no test yet — real input is Phase 3):

```typescript
import React from "react";
import { Text } from "ink";

export const Composer = () => <Text>{"> "}</Text>;
```

- [ ] **Step 2: Build, confirm no regressions**

```bash
pnpm build 2>&1 | tail -5
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/host/renderers/ink/Composer.tsx
git commit -m "feat(ink): minimal Composer stub (Phase 3 wires useInput)"
```

---

### Task 2.7: Overlay components (one file per overlay kind)

**Files:**
- Create: `src/host/renderers/ink/overlays/{CommandPalette,Approval,ApprovalPrompt,QuickHelp,SessionPicker,TimelinePicker,ResumeConfirm}Overlay.tsx`
- Create: `src/host/renderers/ink/OverlayStack.tsx`
- Test: `tests/unit/host/renderers/ink/overlayStack.test.tsx`

- [ ] **Step 1: Copy logic from existing renderers**

Read these — each is small:
- `src/host/renderers/approvalPromptCopy.ts`
- `src/host/renderers/commandPaletteOverlay.ts`
- `src/host/renderers/sessionPickerOverlay.ts`
- `src/host/overlays/quickHelp.ts`

Each existing renderer returns `string[]`. Each new overlay wraps those strings in a `<Box borderStyle="round">`.

- [ ] **Step 2: Write failing test**

Create `tests/unit/host/renderers/ink/overlayStack.test.tsx`:

```typescript
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { initialHostAppState } from "../../../../../src/host/appState.js";
import { reduceHost } from "../../../../../src/host/reducer.js";
import { createHostStore } from "../../../../../src/host/store/index.js";
import { StoreProvider } from "../../../../../src/host/renderers/ink/StoreProvider.js";
import { OverlayStack } from "../../../../../src/host/renderers/ink/OverlayStack.js";

test("OverlayStack: renders nothing when no overlay", () => {
  const store = createHostStore(reduceHost, initialHostAppState());
  const { lastFrame } = render(
    <StoreProvider store={store}>
      <OverlayStack />
    </StoreProvider>,
  );
  assert.equal((lastFrame() ?? "").trim(), "");
});

test("OverlayStack: renders quick_help overlay when set", () => {
  const store = createHostStore(reduceHost, initialHostAppState());
  store.dispatch({ type: "open_quick_help", context: "composer" });
  const { lastFrame } = render(
    <StoreProvider store={store}>
      <OverlayStack />
    </StoreProvider>,
  );
  assert.match(lastFrame() ?? "", /help|\?/i);
});
```

- [ ] **Step 3: Run, expect fail**

```bash
pnpm build && node --test dist/tests/unit/host/renderers/ink/overlayStack.test.js 2>&1 | tail -5
```

- [ ] **Step 4: Implement overlays — minimal-but-equivalent**

For each overlay, port the existing `.ts` renderer's output into a Box. For `QuickHelpOverlay.tsx`:

```typescript
import React from "react";
import { Box, Text } from "ink";
import { DEFAULT_BINDINGS } from "../../../keybindings/defaults.js";
import { getKeybindingsFor } from "../../../keybindings/hooks.js";
import { buildQuickHelpContents } from "../../../overlays/quickHelp.js";
import type { QuickHelpContext } from "../../../appState.js";

export const QuickHelpOverlay = ({
  context,
  dialogKind,
}: {
  context: QuickHelpContext;
  dialogKind?: string;
}) => {
  const bindingContext =
    context === "dialog"
      ? "Dialog"
      : context === "inspect"
        ? "Inspect"
        : context === "transcript"
          ? "Transcript"
          : "Composer";
  const registered = getKeybindingsFor(bindingContext);
  const lines = buildQuickHelpContents(
    context,
    DEFAULT_BINDINGS,
    registered.size > 0 ? registered : undefined,
    dialogKind,
  );
  return (
    <Box borderStyle="round" flexDirection="column" paddingX={1}>
      {lines.map((line, i) => (
        <Text key={i}>{line}</Text>
      ))}
    </Box>
  );
};
```

Create similar thin wrappers for `ApprovalOverlay.tsx` (approval message + `[y/N]`), `ApprovalPromptOverlay.tsx` (wraps `renderApprovalPromptLines` output), `CommandPaletteOverlay.tsx` (wraps `renderCommandPaletteOverlayLines`), `SessionPickerOverlay.tsx` (wraps `renderSessionPickerOverlayLines`), `TimelinePickerOverlay.tsx` (`[timeline picker]` placeholder), `ResumeConfirmOverlay.tsx` (resume? + `[y/N]`).

Because the seven existing `.ts` renderers return `string[]`, each `.tsx` wrapper is ~15 LoC. Pattern (example for `CommandPaletteOverlay.tsx`):

```typescript
import React from "react";
import { Box, Text } from "ink";
import { renderCommandPaletteOverlayLines } from "../../commandPaletteOverlay.js";
import type { CommandPaletteRequest } from "../../../appState.js";

export const CommandPaletteOverlay = ({ request }: { request: CommandPaletteRequest }) => {
  const lines = renderCommandPaletteOverlayLines(request);
  return (
    <Box borderStyle="round" flexDirection="column" paddingX={1}>
      {lines.map((line, i) => (
        <Text key={i} color="cyan">{line}</Text>
      ))}
    </Box>
  );
};
```

Create `OverlayStack.tsx`:

```typescript
import React from "react";
import { useAppState } from "./hooks/useAppState.js";
import { selectRenderFrame } from "../../renderModel.js";
import { CommandPaletteOverlay } from "./overlays/CommandPaletteOverlay.js";
import { ApprovalOverlay } from "./overlays/ApprovalOverlay.js";
import { ApprovalPromptOverlay } from "./overlays/ApprovalPromptOverlay.js";
import { QuickHelpOverlay } from "./overlays/QuickHelpOverlay.js";
import { SessionPickerOverlay } from "./overlays/SessionPickerOverlay.js";
import { TimelinePickerOverlay } from "./overlays/TimelinePickerOverlay.js";
import { ResumeConfirmOverlay } from "./overlays/ResumeConfirmOverlay.js";

export const OverlayStack = () => {
  const state = useAppState((s) => s);
  const frame = selectRenderFrame({ state, transcript: [] });
  const overlay = frame.overlay;
  if (!overlay) return null;
  if (overlay.kind === "command_palette") return <CommandPaletteOverlay request={overlay.request} />;
  if (overlay.kind === "approval") return <ApprovalOverlay message={overlay.message} />;
  if (overlay.kind === "approval_prompt")
    return (
      <ApprovalPromptOverlay request={overlay.request} cursorIndex={overlay.cursorIndex} />
    );
  if (overlay.kind === "quick_help")
    return <QuickHelpOverlay context={overlay.context} dialogKind={overlay.dialogKind} />;
  if (overlay.kind === "session_picker") return <SessionPickerOverlay request={overlay.request} />;
  if (overlay.kind === "timeline_picker") return <TimelinePickerOverlay />;
  return <ResumeConfirmOverlay message={overlay.message} />;
};
```

- [ ] **Step 5: Run, expect pass**

```bash
pnpm build && node --test dist/tests/unit/host/renderers/ink/overlayStack.test.js 2>&1 | tail -5
```

Expected: 2 passes.

- [ ] **Step 6: Commit**

```bash
git add src/host/renderers/ink/overlays/ src/host/renderers/ink/OverlayStack.tsx tests/unit/host/renderers/ink/overlayStack.test.tsx
git commit -m "feat(ink): OverlayStack + 7 overlay components (parity)"
```

---

### Task 2.8: `<App/>` root + `InkBackend`

**Files:**
- Create: `src/host/renderers/ink/App.tsx`
- Create: `src/host/renderers/inkBackend.ts`
- Test: `tests/unit/host/renderers/ink/app.test.tsx`

- [ ] **Step 1: Write failing test**

Create `tests/unit/host/renderers/ink/app.test.tsx`:

```typescript
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { initialHostAppState } from "../../../../../src/host/appState.js";
import { reduceHost } from "../../../../../src/host/reducer.js";
import { createHostStore } from "../../../../../src/host/store/index.js";
import { App } from "../../../../../src/host/renderers/ink/App.js";

test("App: mounts without throwing, shows Bakudo + prompt", () => {
  const store = createHostStore(reduceHost, initialHostAppState());
  const { lastFrame } = render(<App store={store} repoLabel="tmp" />);
  const frame = lastFrame() ?? "";
  assert.match(frame, /Bakudo/);
  assert.match(frame, />/);
});

test("App: transcript updates on dispatch", () => {
  const store = createHostStore(reduceHost, initialHostAppState());
  const { lastFrame, rerender } = render(<App store={store} repoLabel="tmp" />);
  assert.doesNotMatch(lastFrame() ?? "", /hello/);
  store.dispatch({ type: "append_user", text: "hello" });
  rerender(<App store={store} repoLabel="tmp" />);
  assert.match(lastFrame() ?? "", /hello/);
});
```

- [ ] **Step 2: Run, expect fail**

```bash
pnpm build && node --test dist/tests/unit/host/renderers/ink/app.test.js 2>&1 | tail -5
```

- [ ] **Step 3: Implement `<App/>`**

Create `src/host/renderers/ink/App.tsx`:

```typescript
import React from "react";
import { Box } from "ink";
import type { HostStore } from "../../store/index.js";
import { StoreProvider } from "./StoreProvider.js";
import { Header } from "./Header.js";
import { Transcript } from "./Transcript.js";
import { Composer } from "./Composer.js";
import { Footer } from "./Footer.js";
import { OverlayStack } from "./OverlayStack.js";

export const App = ({ store, repoLabel }: { store: HostStore; repoLabel?: string }) => (
  <StoreProvider store={store}>
    <Box flexDirection="column">
      <Header repoLabel={repoLabel} />
      <Box height={1} />
      <Transcript />
      <Box height={1} />
      <OverlayStack />
      <Footer />
      <Composer />
    </Box>
  </StoreProvider>
);
```

- [ ] **Step 4: Implement `InkBackend`**

Create `src/host/renderers/inkBackend.ts`:

```typescript
import React from "react";
import { render, type Instance } from "ink";
import type { RendererBackend } from "../rendererBackend.js";
import type { HostStore } from "../store/index.js";
import { App } from "./ink/App.js";

export class InkBackend implements RendererBackend {
  #instance: Instance | undefined;
  #store: HostStore;
  #repoLabel: string | undefined;

  constructor(store: HostStore, repoLabel?: string) {
    this.#store = store;
    this.#repoLabel = repoLabel;
  }

  mount(): void {
    if (this.#instance) return;
    this.#instance = render(<App store={this.#store} repoLabel={this.#repoLabel} />);
  }

  render(): void {
    // State-driven — nothing to do. Store subscribers handle redraw.
  }

  dispose(): void {
    this.#instance?.unmount();
    this.#instance = undefined;
  }

  async waitUntilExit(): Promise<void> {
    await this.#instance?.waitUntilExit();
  }
}
```

- [ ] **Step 5: Run, expect pass**

```bash
pnpm build && node --test dist/tests/unit/host/renderers/ink/app.test.js 2>&1 | tail -5
```

Expected: 2 passes.

- [ ] **Step 6: Commit**

```bash
git add src/host/renderers/ink/App.tsx src/host/renderers/inkBackend.ts tests/unit/host/renderers/ink/app.test.tsx
git commit -m "feat(ink): App root + InkBackend lifecycle"
```

---

### Task 2.9: Wire `selectRendererBackend` to Ink; delete `TtyBackend`

**Files:**
- Modify: `src/host/rendererBackend.ts`
- Modify: `src/host/interactive.ts`
- Delete: `src/host/renderers/ttyBackend.ts`
- Delete: `src/host/renderers/transcriptRenderer.ts`
- Delete: `src/host/renderers/approvalPromptCopy.ts`
- Delete: `src/host/renderers/commandPaletteOverlay.ts`
- Delete: `src/host/renderers/sessionPickerOverlay.ts`
- Delete: `tests/unit/altScreen.test.ts`

- [ ] **Step 1: Update `rendererBackend.ts`**

Replace imports of `TtyBackend` with `InkBackend`. Keep `PlainBackend` and `JsonBackend` selection rules; change the TTY branch to `new InkBackend(store, repoLabel)`. `selectRendererBackend` now takes a `store` arg.

```typescript
// src/host/rendererBackend.ts
import { InkBackend } from "./renderers/inkBackend.js";
import { PlainBackend } from "./renderers/plainBackend.js";
import { JsonBackend } from "./renderers/jsonBackend.js";
import type { HostStore } from "./store/index.js";

export type RendererBackend = {
  render(frame?: unknown): void;
  dispose?(): void;
  mount?(): void;
  waitUntilExit?(): Promise<void>;
};

export type RendererStdout = {
  write(chunk: string): boolean;
  isTTY?: boolean;
};

export const selectRendererBackend = (opts: {
  store: HostStore;
  stdout: RendererStdout;
  useJson?: boolean;
  forcePlain?: boolean;
  repoLabel?: string;
}): RendererBackend => {
  if (opts.useJson) return new JsonBackend(opts.stdout);
  if (opts.forcePlain || opts.stdout.isTTY !== true) return new PlainBackend(opts.stdout);
  return new InkBackend(opts.store, opts.repoLabel);
};
```

- [ ] **Step 2: Update `interactive.ts` to mount Ink**

After constructing `store`, replace any `TtyBackend` / `renderTick` construction with:

```typescript
const backend = selectRendererBackend({
  store,
  stdout: runtimeIo.stdout as RendererStdout,
  useJson: false,
  forcePlain: false,
  repoLabel,
});
if ("mount" in backend && backend.mount) backend.mount();
```

The `renderTick` function becomes a no-op (Ink is state-driven). Keep `renderTick` as a shim that calls `backend.render()` for Plain/Json, but for Ink it does nothing.

- [ ] **Step 3: Delete retired files**

```bash
git rm src/host/renderers/ttyBackend.ts \
       src/host/renderers/transcriptRenderer.ts \
       src/host/renderers/approvalPromptCopy.ts \
       src/host/renderers/commandPaletteOverlay.ts \
       src/host/renderers/sessionPickerOverlay.ts \
       tests/unit/altScreen.test.ts
```

- [ ] **Step 4: Fix orphaned imports**

```bash
pnpm build 2>&1 | tail -20
```

Expected: compile errors in places that imported the deleted renderers. For each, point at the new Ink equivalents or delete the import if it was only used by the old rendering path. Usually 4-6 sites.

- [ ] **Step 5: Audit `tty-overlay-navigation.test.ts`**

```bash
grep -l "TtyBackend\|transcriptRenderer\|renderTranscriptFrame" tests/ 2>&1
```

If `tty-overlay-navigation.test.ts` imports any of those, convert it to a state-based test (dispatch actions, read `store.getSnapshot().overlay`) or delete it if it's now covered by `overlayStack.test.tsx`.

- [ ] **Step 6: Run full suite**

```bash
pnpm test 2>&1 | tail -10
```

Expected: same 3 pre-existing failures, nothing new.

- [ ] **Step 7: Smoke-test the shell**

```bash
pnpm install:cli
tui-use start --cwd /tmp --cols 140 --rows 40 bakudo
tui-use wait 1500
tui-use type "/version" && tui-use press enter && tui-use wait 1500
tui-use snapshot
tui-use type "/exit" && tui-use press enter && tui-use wait 1000
tui-use kill
```

Expected: Ink renders a visually-similar frame; `/version` dispatches and adds a transcript item.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor(host): retire TtyBackend; InkBackend is the interactive renderer"
```

---

## Phase 3 — Turn driver + input inversion (commit 3)

**Outcome:** Input flows through the store. Turn pipeline runs inside `<TurnDriver/>` as a `useEffect`. `interactive.ts` is a thin bootstrap. `signalHandlers.ts` dispatches cancel actions. Tests green.

---

### Task 3.1: Enhance `<Composer/>` with `useInput` + submit

**Files:**
- Modify: `src/host/renderers/ink/Composer.tsx`
- Test: `tests/unit/host/renderers/ink/composer.test.tsx`

- [ ] **Step 1: Write failing test**

Create `tests/unit/host/renderers/ink/composer.test.tsx`:

```typescript
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { initialHostAppState } from "../../../../../src/host/appState.js";
import { reduceHost } from "../../../../../src/host/reducer.js";
import { createHostStore } from "../../../../../src/host/store/index.js";
import { StoreProvider } from "../../../../../src/host/renderers/ink/StoreProvider.js";
import { Composer } from "../../../../../src/host/renderers/ink/Composer.js";

test("Composer: typed chars appear in the rendered frame", () => {
  const store = createHostStore(reduceHost, initialHostAppState());
  const { stdin, lastFrame } = render(
    <StoreProvider store={store}>
      <Composer />
    </StoreProvider>,
  );
  stdin.write("hello");
  assert.match(lastFrame() ?? "", /hello/);
});

test("Composer: Enter dispatches submit with typed text", async () => {
  const store = createHostStore(reduceHost, initialHostAppState());
  const { stdin } = render(
    <StoreProvider store={store}>
      <Composer />
    </StoreProvider>,
  );
  stdin.write("/version");
  stdin.write("\r");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(store.getSnapshot().pendingSubmit?.text, "/version");
});

test("Composer: empty Enter does NOT dispatch submit", async () => {
  const store = createHostStore(reduceHost, initialHostAppState());
  const { stdin } = render(
    <StoreProvider store={store}>
      <Composer />
    </StoreProvider>,
  );
  stdin.write("\r");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(store.getSnapshot().pendingSubmit, undefined);
});

test("Composer: dispatch_inflight disables text entry and shows label", () => {
  const store = createHostStore(reduceHost, initialHostAppState());
  store.dispatch({ type: "dispatch_started", label: "Routing", startedAt: 1000 });
  const { stdin, lastFrame } = render(
    <StoreProvider store={store}>
      <Composer />
    </StoreProvider>,
  );
  stdin.write("ignored");
  assert.doesNotMatch(lastFrame() ?? "", /ignored/);
  assert.match(lastFrame() ?? "", /Routing/);
});
```

- [ ] **Step 2: Run, expect fail**

```bash
pnpm build && node --test dist/tests/unit/host/renderers/ink/composer.test.js 2>&1 | tail -5
```

- [ ] **Step 3: Implement text-entry Composer**

Replace `src/host/renderers/ink/Composer.tsx`:

```typescript
import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { useAppState } from "./hooks/useAppState.js";
import { useStore } from "./StoreProvider.js";

export const Composer = () => {
  const store = useStore();
  const dispatch = useAppState((s) => s.dispatch);
  const pendingApproval = useAppState((s) => s.promptQueue[0]?.kind === "approval_prompt");
  const [buffer, setBuffer] = useState("");

  useInput((input, key) => {
    // Disable text entry while dispatch is in flight or an approval prompt is open.
    if (dispatch.inFlight) return;
    if (pendingApproval) return; // Approval-prompt keys handled by the overlay; composer passive.

    if (key.return) {
      const text = buffer.trim();
      if (text.length === 0) return;
      store.dispatch({ type: "submit", text });
      setBuffer("");
      return;
    }
    if (key.backspace || key.delete) {
      setBuffer((b) => b.slice(0, -1));
      return;
    }
    if (key.ctrl || key.meta) return;
    if (input && input.length > 0) {
      setBuffer((b) => b + input);
    }
  });

  if (dispatch.inFlight) {
    return (
      <Box flexDirection="column">
        <Text dimColor>{"> "}</Text>
        <Text dimColor>{`${dispatch.label}${dispatch.detail ? ` · ${dispatch.detail}` : ""}`}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="row">
      <Text>{"> "}</Text>
      <Text>{buffer}</Text>
    </Box>
  );
};
```

- [ ] **Step 4: Run, expect pass**

```bash
pnpm build && node --test dist/tests/unit/host/renderers/ink/composer.test.js 2>&1 | tail -5
```

Expected: 4 passes.

- [ ] **Step 5: Commit**

```bash
git add src/host/renderers/ink/Composer.tsx tests/unit/host/renderers/ink/composer.test.tsx
git commit -m "feat(ink): Composer — useInput + submit dispatch"
```

---

### Task 3.2: `<TurnDriver/>` renderless effect

**Files:**
- Create: `src/host/renderers/ink/TurnDriver.tsx`
- Test: `tests/unit/host/renderers/ink/turnDriver.test.tsx`

- [ ] **Step 1: Write failing test**

Create `tests/unit/host/renderers/ink/turnDriver.test.tsx`:

```typescript
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { initialHostAppState } from "../../../../../src/host/appState.js";
import { reduceHost } from "../../../../../src/host/reducer.js";
import { createHostStore } from "../../../../../src/host/store/index.js";
import { StoreProvider } from "../../../../../src/host/renderers/ink/StoreProvider.js";
import { TurnDriver } from "../../../../../src/host/renderers/ink/TurnDriver.js";

test("TurnDriver: on pendingSubmit, runs handler and clears submit", async () => {
  const store = createHostStore(reduceHost, initialHostAppState());
  const seen: string[] = [];
  const runTurn = async (text: string) => {
    seen.push(text);
  };
  render(
    <StoreProvider store={store}>
      <TurnDriver runTurn={runTurn} />
    </StoreProvider>,
  );
  store.dispatch({ type: "submit", text: "hello" });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(seen, ["hello"]);
  assert.equal(store.getSnapshot().pendingSubmit, undefined);
});

test("TurnDriver: runTurn error appends an assistant error message", async () => {
  const store = createHostStore(reduceHost, initialHostAppState());
  const runTurn = async () => {
    throw new Error("boom");
  };
  render(
    <StoreProvider store={store}>
      <TurnDriver runTurn={runTurn} />
    </StoreProvider>,
  );
  store.dispatch({ type: "submit", text: "oops" });
  await new Promise((r) => setTimeout(r, 20));
  const last = store.getSnapshot().transcript.at(-1);
  assert.equal(last?.kind, "assistant");
  if (last?.kind === "assistant") assert.match(last.text, /Error: boom/);
});
```

- [ ] **Step 2: Run, expect fail**

```bash
pnpm build && node --test dist/tests/unit/host/renderers/ink/turnDriver.test.js 2>&1 | tail -5
```

- [ ] **Step 3: Implement `<TurnDriver/>`**

Create `src/host/renderers/ink/TurnDriver.tsx`:

```typescript
import React, { useEffect, useRef } from "react";
import { useAppState } from "./hooks/useAppState.js";
import { useStore } from "./StoreProvider.js";

export type RunTurn = (text: string, signal: AbortSignal) => Promise<void>;

export const TurnDriver = ({ runTurn }: { runTurn: RunTurn }) => {
  const store = useStore();
  const pending = useAppState((s) => s.pendingSubmit);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!pending) return;
    const ac = new AbortController();
    abortRef.current = ac;
    (async () => {
      try {
        await runTurn(pending.text, ac.signal);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        store.dispatch({ type: "append_assistant", text: `Error: ${message}`, tone: "error" });
      } finally {
        store.dispatch({ type: "dispatch_finished" });
        store.dispatch({ type: "clear_pending_submit" });
      }
    })();
    return () => ac.abort();
  }, [pending?.seq, runTurn, store]);

  return null;
};
```

- [ ] **Step 4: Run, expect pass**

```bash
pnpm build && node --test dist/tests/unit/host/renderers/ink/turnDriver.test.js 2>&1 | tail -5
```

Expected: 2 passes.

- [ ] **Step 5: Commit**

```bash
git add src/host/renderers/ink/TurnDriver.tsx tests/unit/host/renderers/ink/turnDriver.test.tsx
git commit -m "feat(ink): TurnDriver — effect-driven turn pipeline"
```

---

### Task 3.3: Rewrite `runInteractiveShell` as Ink bootstrap

**Files:**
- Modify: `src/host/interactive.ts`
- Modify: `src/host/renderers/ink/App.tsx` (add `TurnDriver` mount + `runTurn` prop)

- [ ] **Step 1: Thread `runTurn` through `<App/>`**

Update `src/host/renderers/ink/App.tsx`:

```typescript
import React from "react";
import { Box } from "ink";
import type { HostStore } from "../../store/index.js";
import { StoreProvider } from "./StoreProvider.js";
import { Header } from "./Header.js";
import { Transcript } from "./Transcript.js";
import { Composer } from "./Composer.js";
import { Footer } from "./Footer.js";
import { OverlayStack } from "./OverlayStack.js";
import { TurnDriver, type RunTurn } from "./TurnDriver.js";

export const App = ({
  store,
  repoLabel,
  runTurn,
}: {
  store: HostStore;
  repoLabel?: string;
  runTurn: RunTurn;
}) => (
  <StoreProvider store={store}>
    <Box flexDirection="column">
      <Header repoLabel={repoLabel} />
      <Box height={1} />
      <Transcript />
      <Box height={1} />
      <OverlayStack />
      <Footer />
      <Composer />
    </Box>
    <TurnDriver runTurn={runTurn} />
  </StoreProvider>
);
```

Update `InkBackend` constructor to accept `runTurn`:

```typescript
// src/host/renderers/inkBackend.ts
constructor(store: HostStore, repoLabel: string | undefined, runTurn: RunTurn) {
  this.#store = store;
  this.#repoLabel = repoLabel;
  this.#runTurn = runTurn;
}

mount(): void {
  if (this.#instance) return;
  this.#instance = render(<App store={this.#store} repoLabel={this.#repoLabel} runTurn={this.#runTurn} />);
}
```

- [ ] **Step 2: Rewrite `runInteractiveShell`**

Replace the body of `runInteractiveShell` in `src/host/interactive.ts`:

```typescript
export const runInteractiveShell = async (): Promise<number> => {
  const input = runtimeIo.stdin;
  const output = runtimeIo.stdout;
  if (!input || !output) {
    printUsage();
    return 0;
  }

  const repoRoot = repoRootFor(undefined);
  const repoLabel = basename(repoRoot) || repoRoot;
  const configSnapshot = await loadConfigCascade(repoRoot, {});
  const store = createHostStore(reduceHost, initialHostAppState());

  resetPromptResolvers();
  const prior = await loadHostState(repoRoot);
  if (prior) applyPriorHostState(store, prior);

  const registry = buildDefaultCommandRegistry({ getConfig: () => configSnapshot });
  const execDeps: ExecDeps = {
    resolveInput: resolveInteractiveInput,
    parse: parseHostArgs,
    dispatch: dispatchHostCommand,
    remember: rememberInteractiveContext,
  };

  // The turn pipeline. Called by <TurnDriver/> per submit.
  const runTurn: RunTurn = async (text, signal) => {
    // Route to an active prompt if one exists.
    const head = store.getSnapshot().promptQueue[0];
    if (head) {
      answerPrompt(head.id, text);
      return;
    }
    store.dispatch({ type: "append_user", text });
    store.dispatch({ type: "dispatch_started", label: "Routing", startedAt: Date.now() });
    const deps = buildStoreDeps(store, configSnapshot.merged, repoLabel);
    const dispatched = await registry.dispatch(text, deps);
    if (dispatched.kind === "exit") {
      store.dispatch({ type: "request_exit", code: dispatched.code });
      return;
    }
    if (dispatched.kind === "handled") return;
    if (dispatched.kind === "unknown") {
      const controllerRoute = routePromptToController(text);
      if (controllerRoute) {
        const result = await dispatchThroughController(
          controllerRoute.goal,
          deps,
          controllerRoute.overrideMode,
        );
        applyDispatchResult(result, deps);
        return;
      }
      if (text.startsWith("/")) {
        store.dispatch({
          type: "append_assistant",
          text: `unknown command: ${text.split(/\s+/)[0] ?? text}. Try /help.`,
          tone: "warning",
        });
      }
      return;
    }
    if (dispatched.kind === "fallthrough") {
      await executePromptFromResolution(dispatched.resolution, text, deps, execDeps, signal);
    }
  };

  const backend = selectRendererBackend({
    store,
    stdout: output as RendererStdout,
    repoLabel,
  });
  if ("mount" in backend && backend.mount) backend.mount();

  const unregisterBackendCleanup = registerCleanupHandler(() => backend.dispose?.());
  const uninstallSignals = installSignalHandlers();

  const handleSigint = () => {
    const head = store.getSnapshot().promptQueue[0];
    if (head) {
      cancelPendingPrompt(head.id);
      store.dispatch({ type: "cancel_prompt", id: head.id });
      return;
    }
    store.dispatch({ type: "request_exit", code: 130 });
  };
  const nodeProcess = (globalThis as { process?: { on?: Function; off?: Function } }).process;
  nodeProcess?.on?.("SIGINT", handleSigint);

  // Wait until the app exits (triggered by shouldExit + an unmount effect in <App/>).
  if ("waitUntilExit" in backend && backend.waitUntilExit) {
    await backend.waitUntilExit();
  }

  nodeProcess?.off?.("SIGINT", handleSigint);
  resetPromptResolvers();
  uninstallSignals();
  unregisterBackendCleanup();
  backend.dispose?.();

  const exitCode = store.getSnapshot().shouldExit?.code ?? 0;
  return exitCode;
};
```

Add a `buildStoreDeps` function in `src/host/interactive.ts` (moves the facade logic from Task 1.5 into its own function), and add a small `<App/>` effect that calls `instance.unmount()` when `shouldExit` is set (modify `App.tsx` to include this).

In `src/host/renderers/ink/App.tsx`, add an effect:

```typescript
import { useApp } from "ink";
import { useEffect } from "react";
// …inside App component body (split into a child since StoreProvider is already mounted):
const ExitWatcher = () => {
  const { exit } = useApp();
  const shouldExit = useAppState((s) => s.shouldExit);
  useEffect(() => {
    if (shouldExit) exit();
  }, [shouldExit, exit]);
  return null;
};
// …render <ExitWatcher/> inside StoreProvider alongside TurnDriver.
```

- [ ] **Step 3: Build**

```bash
pnpm build 2>&1 | tail -20
```

Fix type errors from changed signatures.

- [ ] **Step 4: Run the full suite**

```bash
pnpm test 2>&1 | tail -10
```

Expected: same 3 pre-existing failures only.

- [ ] **Step 5: Smoke-test interactively**

```bash
pnpm install:cli
tui-use start --cwd /tmp --cols 140 --rows 40 bakudo
tui-use wait 1500
tui-use type "/version" && tui-use press enter && tui-use wait 1500
tui-use snapshot
tui-use type "/exit" && tui-use press enter && tui-use wait 1500
tui-use kill
```

Expected: input now flows through `useInput`, `/version` dispatches, transcript updates, `/exit` unmounts cleanly.

- [ ] **Step 6: Commit**

```bash
git add src/host/interactive.ts src/host/renderers/ink/App.tsx src/host/renderers/inkBackend.ts
git commit -m "refactor(host): runInteractiveShell is now an Ink bootstrap; turn loop in TurnDriver"
```

---

## Phase 4 — P1 composer polish (commit 4)

**Outcome:** Visible upgrade. Left-rail composer with mode-tinted accent, metadata row, dynamic footer, spinner during dispatch, cleaner transcript gutters already in place from Phase 2.

---

### Task 4.1: `<Spinner/>` component

**Files:**
- Create: `src/host/renderers/ink/Spinner.tsx`
- Test: `tests/unit/host/renderers/ink/spinner.test.tsx`

- [ ] **Step 1: Write failing test**

Create `tests/unit/host/renderers/ink/spinner.test.tsx`:

```typescript
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { Spinner } from "../../../../../src/host/renderers/ink/Spinner.js";

test("Spinner: renders a Braille frame character", () => {
  const { lastFrame } = render(<Spinner />);
  const frame = lastFrame() ?? "";
  assert.match(frame, /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
});
```

- [ ] **Step 2: Run, expect fail**

```bash
pnpm build && node --test dist/tests/unit/host/renderers/ink/spinner.test.js 2>&1 | tail -5
```

- [ ] **Step 3: Implement `<Spinner/>`**

Create `src/host/renderers/ink/Spinner.tsx`:

```typescript
import React, { useEffect, useState } from "react";
import { Text } from "ink";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export const Spinner = ({ color }: { color?: string }) => {
  const [i, setI] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setI((x) => (x + 1) % FRAMES.length), 80);
    return () => clearInterval(id);
  }, []);
  return <Text color={color}>{FRAMES[i]}</Text>;
};
```

- [ ] **Step 4: Run, expect pass**

```bash
pnpm build && node --test dist/tests/unit/host/renderers/ink/spinner.test.js 2>&1 | tail -5
```

Expected: 1 pass.

- [ ] **Step 5: Commit**

```bash
git add src/host/renderers/ink/Spinner.tsx tests/unit/host/renderers/ink/spinner.test.tsx
git commit -m "feat(ink): Spinner component"
```

---

### Task 4.2: Composer left-rail + metadata row + spinner integration

**Files:**
- Modify: `src/host/renderers/ink/Composer.tsx`
- Modify: `tests/unit/host/renderers/ink/composer.test.tsx`

- [ ] **Step 1: Add tests**

Append to `tests/unit/host/renderers/ink/composer.test.tsx`:

```typescript
test("Composer: shows left rail + metadata row when idle", () => {
  const store = createHostStore(reduceHost, initialHostAppState());
  store.dispatch({ type: "set_composer_metadata", model: "sonnet-4.6", agent: "default", provider: "claude" });
  const { lastFrame } = render(
    <StoreProvider store={store}>
      <Composer />
    </StoreProvider>,
  );
  const frame = lastFrame() ?? "";
  assert.match(frame, /┃/);
  assert.match(frame, /standard/);
  assert.match(frame, /sonnet-4\.6/);
  assert.match(frame, /claude/);
});

test("Composer: dispatch_inflight shows spinner glyph alongside label", () => {
  const store = createHostStore(reduceHost, initialHostAppState());
  store.dispatch({ type: "dispatch_started", label: "Dispatching", startedAt: 1000 });
  const { lastFrame } = render(
    <StoreProvider store={store}>
      <Composer />
    </StoreProvider>,
  );
  const frame = lastFrame() ?? "";
  assert.match(frame, /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
  assert.match(frame, /Dispatching/);
});
```

- [ ] **Step 2: Run, expect fail**

```bash
pnpm build && node --test dist/tests/unit/host/renderers/ink/composer.test.js 2>&1 | tail -5
```

- [ ] **Step 3: Update `<Composer/>`**

Replace `src/host/renderers/ink/Composer.tsx`:

```typescript
import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { useAppState } from "./hooks/useAppState.js";
import { useStore } from "./StoreProvider.js";
import { Spinner } from "./Spinner.js";

const modeColor = (mode: string): string => {
  if (mode === "plan") return "cyan";
  if (mode === "autopilot") return "green";
  return "yellow";
};

export const Composer = () => {
  const store = useStore();
  const mode = useAppState((s) => s.composer.mode);
  const autoApprove = useAppState((s) => s.composer.autoApprove);
  const model = useAppState((s) => s.composer.model);
  const agent = useAppState((s) => s.composer.agent);
  const provider = useAppState((s) => s.composer.provider);
  const dispatch = useAppState((s) => s.dispatch);
  const pendingApproval = useAppState((s) => s.promptQueue[0]?.kind === "approval_prompt");
  const [buffer, setBuffer] = useState("");

  useInput((input, key) => {
    if (dispatch.inFlight) return;
    if (pendingApproval) return;
    if (key.return) {
      const text = buffer.trim();
      if (text.length === 0) return;
      store.dispatch({ type: "submit", text });
      setBuffer("");
      return;
    }
    if (key.backspace || key.delete) {
      setBuffer((b) => b.slice(0, -1));
      return;
    }
    if (key.ctrl || key.meta) return;
    if (input && input.length > 0) setBuffer((b) => b + input);
  });

  const approvalLabel = autoApprove ? "AUTO" : "PROMPT";
  const metadataRow = [mode, model || "—", agent || "—", provider || "—", approvalLabel]
    .filter(Boolean)
    .join(" · ");
  const rail = modeColor(mode);

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text color={rail} bold>┃ </Text>
        {dispatch.inFlight ? (
          <Box flexDirection="row">
            <Spinner color={rail} />
            <Text dimColor>{` ${dispatch.label}${dispatch.detail ? ` · ${dispatch.detail}` : ""}`}</Text>
          </Box>
        ) : (
          <Text>{buffer.length > 0 ? buffer : ""}</Text>
        )}
      </Box>
      <Box flexDirection="row">
        <Text dimColor>{`  ${metadataRow}`}</Text>
      </Box>
    </Box>
  );
};
```

- [ ] **Step 4: Run, expect pass**

```bash
pnpm build && node --test dist/tests/unit/host/renderers/ink/composer.test.js 2>&1 | tail -5
```

Expected: all 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/host/renderers/ink/Composer.tsx tests/unit/host/renderers/ink/composer.test.tsx
git commit -m "feat(ink): composer left-rail + metadata row + spinner"
```

---

### Task 4.3: Dynamic `<Footer/>` polish

**Files:**
- Modify: `src/host/renderers/ink/Footer.tsx`
- Modify: `tests/unit/host/renderers/ink/footer.test.tsx`

- [ ] **Step 1: Add failing tests**

Append to `tests/unit/host/renderers/ink/footer.test.tsx`:

```typescript
test("Footer: shows /-commands + ? + Ctrl+C hints in idle state", () => {
  const store = createHostStore(reduceHost, initialHostAppState());
  const { lastFrame } = render(
    <StoreProvider store={store}>
      <Footer />
    </StoreProvider>,
  );
  const frame = lastFrame() ?? "";
  assert.match(frame, /\[\/\] commands/);
  assert.match(frame, /\[\?\] help/);
  assert.match(frame, /\[Ctrl\+C\] exit/);
});

test("Footer: shows context placeholder", () => {
  const store = createHostStore(reduceHost, initialHostAppState());
  const { lastFrame } = render(
    <StoreProvider store={store}>
      <Footer />
    </StoreProvider>,
  );
  assert.match(lastFrame() ?? "", /context —%/);
});
```

- [ ] **Step 2: Run, expect fail**

```bash
pnpm build && node --test dist/tests/unit/host/renderers/ink/footer.test.js 2>&1 | tail -5
```

- [ ] **Step 3: Update `<Footer/>`**

Replace `src/host/renderers/ink/Footer.tsx`:

```typescript
import React from "react";
import { Box, Text } from "ink";
import { useAppState } from "./hooks/useAppState.js";

const hintsFor = (state: {
  screen: string;
  overlayKind?: string;
  inFlight: boolean;
}): string[] => {
  if (state.overlayKind === "approval_prompt")
    return ["[1/2/3/4] choose", "[Shift+Tab] cycle", "[?] help", "[Ctrl+C] exit"];
  if (state.overlayKind === "command_palette" || state.overlayKind === "session_picker")
    return ["[↑/↓] move", "[Enter] select", "[?] help", "[Ctrl+C] exit"];
  if (state.overlayKind === "quick_help") return ["[?] close", "[Ctrl+C] exit"];
  if (state.screen === "inspect")
    return ["[Shift+Tab] tabs", "[↑/↓] scroll", "[?] help", "[Ctrl+C] exit"];
  if (state.inFlight) return ["[Esc] cancel", "[Ctrl+C] quit"];
  return ["[/] commands", "[?] help", "[Ctrl+C] exit"];
};

export const Footer = () => {
  const screen = useAppState((s) => s.screen);
  const overlayKind = useAppState((s) => s.promptQueue[0]?.kind ?? s.quickHelp?.context);
  const inFlight = useAppState((s) => s.dispatch.inFlight);
  const hints = hintsFor({ screen, overlayKind, inFlight });
  return (
    <Box flexDirection="row" justifyContent="space-between">
      <Text dimColor>{hints.join("  ")}</Text>
      <Text dimColor>{"context —%"}</Text>
    </Box>
  );
};
```

- [ ] **Step 4: Run, expect pass**

```bash
pnpm build && node --test dist/tests/unit/host/renderers/ink/footer.test.js 2>&1 | tail -5
```

Expected: 3 passes.

- [ ] **Step 5: Commit**

```bash
git add src/host/renderers/ink/Footer.tsx tests/unit/host/renderers/ink/footer.test.tsx
git commit -m "feat(ink): dynamic footer — /-commands, ? help, context slot, overlay-aware"
```

---

### Task 4.4: End-to-end tui-use verification + documentation update

**Files:**
- Modify: `plans/bakudo-ux/handoffs/phase-5.md`

- [ ] **Step 1: Visual verification**

```bash
pnpm install:cli
tui-use start --cwd /tmp --cols 140 --rows 40 bakudo
tui-use wait 1500
tui-use snapshot > /tmp/ink-startup.txt
tui-use type "/mode plan" && tui-use press enter && tui-use wait 1500
tui-use snapshot > /tmp/ink-plan.txt
tui-use type "/version" && tui-use press enter && tui-use wait 1500
tui-use snapshot > /tmp/ink-version.txt
tui-use type "/exit" && tui-use press enter && tui-use wait 1000
tui-use kill
```

Check each snapshot manually for:
- `┃` left-rail visible (cyan/yellow/green by mode)
- Metadata row `standard · — · — · — · PROMPT` below
- Footer `[/] commands  [?] help  [Ctrl+C] exit` + `context —%`
- Transcript items show `› ` / `• ` / `✓` gutters (no `· version`)
- Mode chip updates to PLAN on `/mode plan`
- `/version` appends a transcript item

- [ ] **Step 2: Update phase-5 handoff**

Amend `plans/bakudo-ux/handoffs/phase-5.md` section "Architectural lock-ins" — add a note under lock-in 15:

```markdown
**Update 2026-04-19:** Lock-in 15 overturned by `docs/superpowers/specs/2026-04-19-ink-migration-design.md`. Interactive renderer is now Ink. Plain/Json backends unchanged.
```

- [ ] **Step 3: Full-suite final check**

```bash
pnpm test 2>&1 | tail -10
```

Expected: 3 pre-existing failures; no new failures.

- [ ] **Step 4: Commit**

```bash
git add plans/bakudo-ux/handoffs/phase-5.md
git commit -m "docs: lock-in 15 overturned — Ink migration complete"
```

---

## Self-review notes (author's)

- **Spec coverage:** every spec section is tasked. Store (Task 1.4), state additions (1.1), reducer actions (1.2/1.3), component tree (2.3-2.8), Composer polish (4.2), dynamic footer (4.3), spinner (4.1), TurnDriver + input inversion (3.1-3.3), deletion of TtyBackend (2.9). Overlay popover positioning, autocomplete, context %, and history persistence are explicit P2 non-goals — not tasked.
- **Placeholder scan:** no TBDs. Every code step has the code. Every test has assertions. Commands are concrete.
- **Type consistency:** `HostAction` union extended in 1.2 + 1.3. `useAppState<T>(selector: (s: HostAppState) => T): T` used consistently. `RunTurn` signature is stable from 3.2 onward. `HostStore` exports `getSnapshot / subscribe / dispatch` everywhere.
- **Known gap:** Task 1.5's `deps.transcript` facade uses `as unknown as TranscriptItem[]` — a targeted any-cast to preserve the existing TickDeps shape. This is the "StoreDeps migration debt" called out in the spec's Risks section.

---

## Commit map (for PR description)

- Commit 1 (Phase 1): `feat(host): extend HostAppState with transcript + composer metadata + dispatch`, `feat(host): reducer actions for transcript mutation`, `feat(host): reducer actions for dispatch lifecycle + submit/exit`, `feat(host): createHostStore — subscribe/getSnapshot/dispatch wrapper`, `refactor(host): route interactive deps through createHostStore`.
- Commit 2 (Phase 2): `build: add ink 7 + react 19 + ink-testing-library; enable JSX`, 6 × `feat(ink): <component>`, `refactor(host): retire TtyBackend; InkBackend is the interactive renderer`.
- Commit 3 (Phase 3): `feat(ink): Composer — useInput + submit dispatch`, `feat(ink): TurnDriver — effect-driven turn pipeline`, `refactor(host): runInteractiveShell is now an Ink bootstrap; turn loop in TurnDriver`.
- Commit 4 (Phase 4): `feat(ink): Spinner component`, `feat(ink): composer left-rail + metadata row + spinner`, `feat(ink): dynamic footer`, `docs: lock-in 15 overturned — Ink migration complete`.
