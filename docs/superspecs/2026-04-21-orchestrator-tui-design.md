# Orchestrator TUI Design

**Status:** Approved 2026-04-21
**Scope:** Introduce a live, interactive UI surface for the Cognitive Meta-Orchestrator within the existing Ink component tree.

---

## Problem

Waves 1–5 of the Cognitive Meta-Orchestrator built a powerful, autonomous background engine capable of decomposing objectives into campaigns, executing them in parallel, and synthesizing the results. However, this engine was entirely headless (`headlessExecute.ts`).

When users ran the interactive `bakudo` shell, they were still constrained to the single-shot `SessionController` path. If a user asked to "refactor the reducer into smaller files," the system would try to accomplish it in one giant, context-heavy attempt rather than leveraging the Explorer, Architect, and Synthesizer roles.

Furthermore, there was no visibility into the orchestrator's state. Users had no way to see the decomposition tree, track parallel campaigns, or monitor the Git mutex.

## Goals

1. **Bridge the Gap:** Allow the interactive shell to route complex goals into the meta-orchestrator pipeline.
2. **Visibility:** Provide a live, real-time view of the orchestrator's internal state (Objectives, Campaigns, Mutex).
3. **Aesthetic Alignment:** Match the terminal aesthetic using a GitHub-dark palette for the new UI elements.
4. **Non-Disruptive:** Preserve the single-shot session path for simple queries, and make the new UI collapsible.

---

## Architecture

The solution introduces three new components to the host architecture:

1. `RoutingClassifier` (Heuristic Intent Routing)
2. `OrchestratorDriver` (TUI-to-Headless Bridge)
3. `Sidebar` (Ink Component)

### 1. RoutingClassifier

`src/host/orchestration/routingClassifier.ts`

To avoid the latency and cost of an LLM call on every keystroke, the `RoutingClassifier` uses deterministic heuristic rules to classify the user's prompt as either `simple` or `complex`.

- **Simple:** Empty strings, slash commands (`/help`), short questions starting with "what/how/explain", or prefixes like "show me", "list", "find", "read".
- **Complex:** Prompts containing keywords like "refactor", "implement", "migrate", "redesign", or any prompt longer than 60 characters that doesn't match a simple question pattern.

**Integration:** In `interactive.ts`, `runTurn()` checks `classifyGoal(text)`. If simple, it routes to the existing `answerHeadPrompt` / `executePromptFromResolution` path. If complex, it routes to `runObjectiveInTUI()`.

### 2. OrchestratorDriver

`src/host/orchestration/orchestratorDriver.ts`

The `OrchestratorDriver` bridges the interactive shell's Redux store with the headless `ObjectiveController`.

It exposes `runObjectiveInTUI(store, text, repoPath, ...deps)`. This function:
1. Dispatches `orchestrator_start` to the store.
2. Enters a `while (!controller.isComplete())` loop.
3. Calls `controller.advance()`.
4. Dispatches `orchestrator_objective_update` to sync the state tree.
5. Emits `append_event` and `append_review` actions to stream progress into the main transcript, so the user sees live narration ("Worker is producing output", "Synthesizer merged candidate").
6. Dispatches `orchestrator_complete` or `orchestrator_failed` when the loop exits.

This design respects the **Headless Execution Boundary** invariant: the actual work is still driven by `ObjectiveController` and `headlessExecute.ts`, but the driver syncs the state back to the TUI store.

### 3. Sidebar Component

`src/host/renderers/ink/Sidebar.tsx`

The `Sidebar` is a new Ink component rendered alongside the `MainPanel` in a horizontal flex layout. It is bound to the `orchestrator` slice of the `HostAppState`.

**State Slice (`appState.ts`):**
```typescript
export type OrchestratorSlice = {
  objectives: Objective[];
  sidebarVisible: boolean;
  activeCampaignId?: string;
  gitMutexLocked: boolean;
  lastVerdict?: string;
};
```

**Visual Design:**
The sidebar uses a GitHub-dark palette to fit the terminal aesthetic:
- Background: `#161b22` (GitHub Dark Canvas)
- Borders: `#30363d` (GitHub Dark Border)
- Text: `#c9d1d9` (GitHub Dark Text)
- Accents: `#58a6ff` (Blue), `#3fb950` (Green), `#f85149` (Red), `#d29922` (Yellow)

**Sections:**
- **Header:** "Orchestrator"
- **Objective:** The high-level goal and status badge (Active/Completed/Failed).
- **Campaign Tree:** A list of decomposed campaigns. Shows a spinner `⏳` for pending, a blue `▶` for running, a green `✓` for completed, and a red `✗` for failed.
- **Git Mutex:** Live status of the daemon-level write lock (`Free` or `Locked by [Agent]`).
- **Last Verdict:** The most recent Critic or Synthesizer review summary.

**Interaction:**
The sidebar is collapsible. Users can press `[Tab]` in an empty composer buffer to toggle `sidebarVisible`.

## Testing Strategy

- **Unit Tests:** `routingClassifier.test.ts` covers all heuristic branches (40+ assertions).
- **Reducer Tests:** `orchestratorReducer.test.ts` verifies the state transitions for the 7 new orchestrator actions.
- **Component Tests:** `sidebar.test.tsx` uses `ink-testing-library` to verify rendering states (hidden, empty, active campaigns, mutex locked).

## Future Work (P2)

- Allow users to manually intervene or cancel specific campaigns from the sidebar.
- Persist the orchestrator state across shell restarts (currently, `HostAppState.orchestrator` is ephemeral per session launch).
- Add a dedicated `/orchestrator` inspect tab for deep-diving into historical campaign candidate sets.
