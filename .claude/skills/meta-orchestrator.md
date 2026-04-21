# Cognitive Meta-Orchestrator Rules

This skill defines the critical architectural invariants for the Bakudo Cognitive Meta-Orchestrator. You MUST follow these rules when implementing new background agents, modifying the orchestration loop, or interacting with the `abox` sandbox.

## 1. Headless Execution Boundary

The `headlessExecute.ts` module is the **only** permitted entry point for background, daemon, or autonomous agent execution.
- **NEVER** import or invoke `SessionController` or any interactive TUI components from daemon code.
- Background execution is strictly non-interactive. All prompts, approvals, and user inputs are forbidden in this path.

## 2. Daemon-Level Git Mutex

All background agents that perform write operations (e.g., `Curator`, `Janitor`, `Synthesizer`) MUST acquire the `gitWriteMutex` before modifying the repository.
- The mutex prevents concurrent agents from corrupting the Git tree.
- Read-only agents (e.g., `Explorer`, `Critic`) do not require the mutex.

## 3. Strict No-Auto-Merge Policy

Background agents are forbidden from pushing directly to protected branches (e.g., `main`, `master`) or auto-merging Pull Requests.
- Agents MUST create a new branch, commit their changes, and open a Pull Request.
- The PR MUST wait for human review and approval.
- You must enforce this by providing explicit instructions in the agent's system prompt (e.g., `JANITOR_HYGIENE_PROMPT`, `CURATOR_PROMPT`).

## 4. No Raw Credentials

The orchestrator and its agents MUST NEVER inject raw credentials (e.g., API keys, tokens) via environment variables.
- The `ProviderRegistry` (`src/host/providerRegistry.ts`) defines the required policies for each agent profile.
- The `abox` sandbox runtime is exclusively responsible for injecting TLS-proxy stubs based on these policies.

## 5. The Chaos Monkey Loop

All worker executions in the headless path are subject to the Chaos Monkey adversarial loop.
- The `Critic` agent evaluates the worker's output.
- If the output is substandard, the orchestrator forces a retry (up to 3 times).
- When implementing new agents, assume their output will be criticized and ensure they can handle iterative refinement.

## 6. Interactive TUI Routing

The interactive shell (`interactive.ts`) routes user input through a `RoutingClassifier` before dispatching work.
- **Simple goals** (short questions, slash commands, file lookups) are routed to the standard `SessionController` path.
- **Complex goals** (refactors, implementations, multi-step changes) are routed to `runObjectiveInTUI()` in `orchestratorDriver.ts`, which drives `ObjectiveController` and streams state updates back to the Ink store.
- The `OrchestratorDriver` is the **only** permitted bridge between the interactive shell and the headless orchestration layer. It MUST NOT call `SessionController` or `executePromptFromResolution` directly for complex goals.
- The `Sidebar` component (`src/host/renderers/ink/Sidebar.tsx`) reads from the `orchestrator` slice of `HostAppState` and is the sole visual surface for orchestrator state in the TUI. It is collapsible via `[Tab]`.
