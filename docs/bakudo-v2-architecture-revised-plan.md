# Bakudo v2 Architecture & Implementation Plan (Revised)

This revised plan updates the original `v2-architecture-plan` to align with the actual capabilities of `abox v0.3.1`, the preserved worktree lifecycle introduced in the `control-plane-spec`, and the requirement for a provider-agnostic, TUI-driven architecture.

## 1. Core Architectural Shifts from Original v2 Plan

### 1.1. Preserved Worktrees & Host-Owned Lifecycles
**Original Plan:** Assumed ephemeral sandboxes and an `abox_apply_patch` MCP tool.
**Revision:** The architecture must fully embrace the preserved worktree model introduced in `abox v0.3.1` and the `control-plane-spec`.
*   **Worktrees:** Sandboxes are created via `abox run` (which implicitly creates a worktree via `Git2Workspace`). The worktree persists after the VM stops unless `--clean` is explicitly passed to `abox stop`.
*   **Lifecycle:** The host (Bakudo) manages the lifecycle via `abox run`, `abox stop`, `abox divergence`, and `abox merge`. The Deliberator (agent) inside the VM does *not* merge its own code. It exits (successfully or with an error), and Bakudo inspects the `abox divergence` output before deciding to `abox merge`.

### 1.2. Provider-Agnostic Communication (Replacing MCP Wiring Inversion)
**Original Plan:** Proposed an inverted MCP architecture where the Deliberator inside the VM connects out to the Supervisor (Bakudo) via an MCP client.
**Revision:** This is fundamentally incompatible with how tools like Claude Code and Codex operate. They spawn MCP servers as child processes and communicate via stdio. They cannot act as MCP clients connecting to a remote server.
*   **The Solution: Stdin Prompt Injection & File-Based IPC.** We will retain the provider-agnostic approach used in Bakudo v1.
*   **Input:** The system prompt, task instructions, and initial context are injected into the agent via `stdin` when the VM boots (facilitated by `abox`'s `runner.sh` which pipes stdin or reads from `boot_meta.rs`).
*   **Output:** The agent writes its results, structured data, and completion status to a designated output directory (e.g., `/abox-status/` or a specific path mapped to the host).
*   **Why this works:** Both `claude -p` (non-interactive mode) and `codex exec` natively support reading prompts from stdin and writing outputs to files or stdout. This requires zero custom MCP server configuration inside the guest and remains 100% provider-agnostic.

### 1.3. Abox Capability Alignment
**Original Plan:** Assumed non-existent features like named profiles and JSON output for `abox run`.
**Revision:** We will use the actual `abox v0.3.1` CLI flags.
*   **Run:** `abox run --task <id> --base <branch> --detach -- <agent_command>`
*   **Environment:** Use `-e KEY=VALUE` for environment variable injection (e.g., setting the output directory path).
*   **Credentials:** Rely on `abox`'s built-in HTTPS credential injection (via `policies/default.toml` and `boot_meta.rs`) to securely provide API keys to Claude/Codex without passing them in plaintext env vars.

### 1.4. TUI and Chat Interface
**Original Plan:** Mentioned TUI enhancements but lacked specifics on maintaining a polished chat interface.
**Revision:** The UI will be built using `ratatui` (leveraging the patterns already present in `abox-cli/src/tui/dashboard.rs`).
*   **Layout:** A multi-pane layout.
    *   **Main Pane:** A polished, scrollable chat interface showing the history of user requests, agent reasoning, and system events.
    *   **Side/Top Panels (or Tabs):** Real-time status of active sandboxes, worktree divergence, and system metrics (CPU/Memory).
*   **Slash Commands:** Implement slash commands in the chat input for configuration (e.g., `/provider claude-code`, `/model claude-3-7-sonnet-20250219`).

---

## 2. Updated Implementation Phases

### Phase 1: Foundation & Abstraction Update (Days 1-2)
**Goal:** Update the Bakudo core to interact correctly with `abox v0.3.1` using the preserved worktree model.
1.  **Abox Adapter Rewrite:** Refactor `src/aboxAdapter.ts` to use the correct `abox` CLI commands (`run --detach`, `stop`, `divergence`, `merge`).
2.  **Provider Registry:** Ensure `providerRegistry.ts` correctly maps provider IDs to their non-interactive command equivalents (e.g., `claude -p` for Claude Code, `codex exec` for Codex).
3.  **File-Based IPC:** Implement the host-side logic to read the structured output files written by the agent into the shared `/abox-status/` or mapped workspace directory.

### Phase 2: State Management & Concurrency Fixes (Days 3-4)
**Goal:** Resolve the concurrency and state issues identified in the Claude assessment.
1.  **Multi-Mission Multiplexing:** Implement a robust state machine in the Supervisor to track multiple active `task_id`s simultaneously.
2.  **Crash Recovery:** Move away from relying solely on PID files for crash recovery. Use `abox list` to reconcile the actual state of running VMs with Bakudo's internal state database.
3.  **Wallet Reservation:** Implement atomic locks or a dedicated resource manager for budget/wallet reservations to prevent race conditions when multiple agents request funds.

### Phase 3: TUI Development (Days 5-7)
**Goal:** Build the polished `ratatui` interface.
1.  **Chat Interface:** Implement the core chat view, message history, and input handling.
2.  **Slash Commands:** Add the parser and handlers for `/provider`, `/model`, `/config`, etc.
3.  **Observability Panels:** Integrate the `abox list` and `abox divergence` data into side panels or tabs to provide real-time visibility into sandbox states.

### Phase 4: Agent Workflow & Merging (Days 8-10)
**Goal:** Implement the full end-to-end flow using the new primitives.
1.  **Task Dispatch:** The Supervisor formats the prompt, allocates a `task_id`, and calls `abox run --detach`.
2.  **Monitoring:** The Supervisor polls the output directory or listens for the VM exit event.
3.  **Evaluation & Merge:** Once the VM exits, the Supervisor runs `abox divergence`. If the task was successful (based on the agent's structured output) and the divergence is acceptable, the Supervisor executes `abox merge`.
4.  **Cleanup:** The Supervisor calls `abox stop --clean` to remove the worktree if the task is fully complete and merged, or leaves it preserved for debugging if it failed.

---

## 3. Resolving the Critical Gaps

| Gap Identified | Resolution in Revised Plan |
| :--- | :--- |
| **MCP Wiring Inversion** | Abandoned. We will use standard `stdin` prompt injection and file-based output, which is natively supported by both `claude -p` and `codex exec` and requires zero guest-side configuration. |
| **abox Capability Mismatches** | Updated the `aboxAdapter` design to use only verified `v0.3.1` flags (`--detach`, `-e`, etc.). Removed reliance on non-existent JSON output for the `run` command. |
| **Control-Plane Regression** | Fully adopted the preserved worktree model. Bakudo (host) manages `abox run`, `abox divergence`, and `abox merge`. Agents no longer attempt to merge their own code. |
| **Concurrency & State** | Added Phase 2 to explicitly address state reconciliation via `abox list` and atomic resource management for budgets. |

## 4. Next Steps
1.  Review this revised architecture document.
2.  If approved, we can begin Phase 1 implementation, starting with the `aboxAdapter.ts` rewrite to align with `v0.3.1`.
