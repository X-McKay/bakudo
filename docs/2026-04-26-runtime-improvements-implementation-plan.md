# 2026-04-26 Runtime Improvements Implementation Plan

Status: Implemented (Phases 1-5 complete; branch hardening verified)

Date: 2026-04-26

Owner: Bakudo maintainers

Supersedes: `claude-consolidated-plan.md`,
`manus-simplified-conductor-plan.md`,
`provider-conductor-implementation-plan.md`

Branch: `feature/20260426-improvements`

Worktree: `.worktrees/20260426-improvements`

## Executive Decision

This branch should address operator trust, runtime correctness, and autonomy
guardrails together.

Meta-awareness and worker hand-offs are first-class deliverables in this plan.
They are not follow-on polish. The runtime should become materially better at:

- showing what work was delegated, to whom, with what policy
- showing what a worker is doing while it is running
- answering natural-language operator questions from real runtime state
- preserving durable mission state without silent fallback behavior
- avoiding tight wake timeout loops
- applying autonomous changes with stronger verification

The branch should not start with a large architecture rewrite. The right near-
term move is to improve the existing seams in `bakudo`, not to merge every
store into one authority or rebuild the entire controller layer.

## Goals

1. Prevent silent mission-state amnesia and make missing state an explicit
   error path.
2. Make worker delegation and completion legible in the transcript, shelf, and
   status surfaces.
3. Make host-side status and steering conversational without relying on exact
   phrase matching.
4. Add durable timeout backoff so a degraded provider does not spin wakes.
5. Reduce risk in preserved worktree snapshots and auto-apply flows.
6. Add a verification gate for autonomous merges.

## Non-Goals

- Do not merge `SandboxLedger` into `MissionStore` in this branch.
- Do not attempt a full `SessionController` breakup before the product
  behavior is corrected.
- Do not add a broad host shell or generic host file-write surface.
- Do not route every host input through a second model by default.
- Do not redesign the entire TUI layout beyond what is needed for better live
  activity and hand-off visibility.

## Delivery Order

The delivery order is intentional:

1. Worker hand-offs and live progress
2. Host meta-awareness and structured steering
3. Mission-state integrity and wake timeout backoff
4. Worktree hardening and path authority cleanup
5. Pre-merge verification for autonomous apply
6. Optional cleanup and decomposition work

This ordering front-loads the user-visible product improvements while still
fixing the most dangerous correctness issue before the branch is considered
done.

## Guardrails

The following remain binding:

1. Repo mutation and code execution continue to happen inside `abox`.
2. Host-owned merge, preserve, and discard policy remains host-owned.
3. `MissionStore` remains the durable mission authority for mission runtime
   state.
4. `SandboxLedger` continues to exist for repo-scoped sandbox visibility and
   recovery in this branch.
5. The TUI continues to communicate with the daemon through `SessionCommand`
   and `SessionEvent`.
6. Any cross-repo dependency on `abox` should be sequenced upstream first, then
   integrated into `bakudo`, then verified with `just integration-test`.

## Phase 1: Worker Hand-Offs and Live Progress

### Outcome

When Bakudo dispatches a worker, the operator should see:

- an explicit hand-off block with provider, model, sandbox lifecycle, and
  candidate policy
- live activity updates that distinguish running commands, file exploration,
  code edits, tool calls, and generic narration
- a completion block with summary, exit code, duration, and resulting
  worktree state

### Files

- `crates/bakudo-core/src/protocol.rs`
- `crates/bakudo-core/src/provider.rs`
- `crates/bakudo-daemon/src/worker/mod.rs`
- `crates/bakudo-daemon/src/task_runner.rs`
- `crates/bakudo-daemon/src/session_controller.rs`
- `crates/bakudo-tui/src/app.rs`
- `crates/bakudo-tui/src/status_indicator.rs`
- `crates/bakudo-tui/src/ui.rs`
- `tests/runtime.rs`

### Implementation

- [x] Unify the classic and mission worker wrappers into one shared wrapper
      implementation.
  The shared implementation should live in one module and standardize on the
  `BAKUDO_SUMMARY:` contract.

- [x] Expand `WorkerProgressKind` with semantic activity variants.
  Target variants:
  `CommandExecution`, `FileExploration`, `CodeEdit`, `ToolCall`,
  `ToolResult`, `AssistantMessage`, `StatusUpdate`, `Heartbeat`.

- [x] Add an optional structured metadata field to `WorkerProgressEvent`.
  Keep `message` for display, but allow structured payloads for path and
  command-specific rendering.

- [x] Emit heartbeats from the shared wrapper.
  The existing `AttemptBudget.heartbeat_interval_ms` is currently unused and
  should become active.

- [x] Teach the wrapper to classify common progress lines into semantic events.
  Start with deterministic, conservative extraction:
  command execution, file reads, file edits, tool call boundaries, summary
  emission, and plain fallback narration.

- [x] Extend `SessionEvent::TaskStarted` and `SessionEvent::TaskFinished`.
  Include enough context to render explicit hand-off and completion blocks
  without re-querying state:
  provider, model, lifecycle, candidate policy, timeout, summary, exit code,
  duration, and final state.

- [x] Update the TUI transcript rendering to bracket worker runs.
  The start event should render an explicit hand-off annotation.
  The finish event should render a matching resolved annotation.

- [x] Add a dedicated live activity surface in the TUI.
  The first implementation can be a focused activity block backed by shelf
  state rather than a large pane redesign.

- [x] Keep the top status strip, but make it summarize real worker activity
  rather than only generic running state.

### Acceptance Criteria

- Dispatching a worker produces a visibly richer start annotation.
- Running work surfaces at least commands, file exploration, and edits when
  detectable.
- The transcript remains readable and does not degrade into raw line spam.
- The end of a worker run is visibly paired with the start of that run.
- Existing provider flows still work for classic one-shot execution and mission
  workers.

### Verification

- `cargo test -p bakudo-core protocol`
- `cargo test -p bakudo-daemon task_runner`
- `cargo test -p bakudo-tui app`
- `cargo test -p bakudo-tui status_indicator`
- `just test-bakudo`

## Phase 2: Host Meta-Awareness and Structured Steering

### Outcome

An operator should be able to ask:

- "What is running right now?"
- "What is the mission waiting on?"
- "Why did we stop?"
- "What preserved worktrees need review?"
- "How many workers are active?"

and get an answer generated from real mission and ledger state, not from exact
string matches.

### Files

- `crates/bakudo-daemon/src/host.rs`
- `crates/bakudo-daemon/src/session_controller.rs`
- `crates/bakudo-daemon/src/mission_store.rs`
- `crates/bakudo-core/src/mission.rs`
- `crates/bakudo-tui/src/app.rs`
- `tests/runtime.rs`

### Implementation

- [x] Replace `is_status_query` phrase matching with a structured host-intent
      layer.
  Introduce a `HostIntent` enum with at least:
  `StatusSummary`, `RunningWorkers`, `MissionBlockers`, `Candidates`,
  `MissionSteering`, `MissionStart`, and `ClarifyStart`.

- [x] Build a richer `HostSnapshot`.
  The snapshot should include:
  ledger entries, active mission summary, queued wakes, active wave summary,
  pending approvals, pending user questions, latest tool call error, and the
  current provider/model view.

- [x] Move snapshot construction into mission runtime code rather than leaving
  `HostRuntime` to infer everything from partial fields.

- [x] Add dedicated renderers for the common operator questions.
  These renderers should answer using live mission and ledger state rather than
  canned text templates keyed only on the input string.

- [x] Keep steering local and deterministic.
  Inputs classified as steering should still enqueue a mission message through
  the existing runtime flow.

- [x] Add an extension seam for a future cheap host model, but do not require
  one in the first implementation.
  The branch should land a better deterministic host layer first.

### Acceptance Criteria

- Host replies are derived from current mission state, wake state, and ledger
  state.
- The operator can ask for current status in more natural ways than the
  current exact-match list.
- Steering still routes into the active mission without ambiguity.
- No new host-side generic execution power is introduced.

### Verification

- Add focused tests in `host.rs` for intent classification and status replies.
- Add runtime tests that cover active mission, queued wake, preserved worktree,
  and blocked approval cases.
- `just test-bakudo`

## Phase 3: Mission-State Integrity and Wake Timeout Backoff

### Outcome

Missing durable mission state should become an explicit error for existing
missions, and timeouts should back off rather than immediately re-entering the
same degraded wake loop.

### Files

- `crates/bakudo-daemon/src/mission_store.rs`
- `crates/bakudo-daemon/src/session_controller.rs`
- `crates/bakudo-core/src/mission.rs`
- `tests/runtime.rs`

### Implementation

- [x] Split mission-state loading into two behaviors:
  one path for initial mission creation and one path for loading existing
  mission state.

- [x] Stop returning `MissionState::default_layout()` for an existing mission
      when the row is missing.
  Missing state for an existing mission should surface a hard error or enter a
  defined recovery path.

- [x] Ensure mission creation writes mission row, mission state, and
      `mission_plan.md` in one coherent flow.
  If needed, add a higher-level mission initialization helper in
  `MissionStore` or `MissionCore`.

- [x] Add durable wake backoff.
  Introduce a `not_before` or equivalent scheduled-at field for wakes so
  timeout follow-ups can be delayed rather than processed immediately.

- [x] On provider wake timeout, enqueue the next timeout wake with exponential
      backoff and jitter within bounded limits.
  The wake payload should carry enough detail for operator introspection.

- [x] Surface timeout streaks and next wake timing in the mission banner or
      host status output.

### Acceptance Criteria

- Existing mission state can no longer silently reset to a default layout.
- Timeout wakes do not spin immediately in a tight loop.
- Operators can see that a mission is sleeping because of backoff rather than
  because it is idle.

### Verification

- Add store tests for missing-state behavior.
- Add runtime tests for repeated deliberator timeout and backoff scheduling.
- `just test-bakudo`

## Phase 4: Worktree Hardening and Path Authority Cleanup

### Outcome

Worktree handling should become more deterministic and less risky without
changing Bakudo's host-owned candidate policy model.

### Files

- `crates/bakudo-daemon/src/worktree.rs`
- `crates/bakudo-daemon/src/candidate.rs`
- `crates/bakudo-daemon/src/task_runner.rs`
- `crates/bakudo-core/src/state.rs`
- `crates/bakudo-core/src/abox.rs`
- `tests/runtime.rs`

### Implementation

- [x] Centralize worktree branch-name formatting and worktree-path resolution in
      a single host-owned helper module.

- [x] Remove duplicated `agent/<task_id>` formatting from multiple modules.

- [x] Prefer structured worktree path capture over stdout scraping.
  If `abox` already exposes enough structured data, consume it directly.
  If it does not, add the upstream `abox` change first and then wire Bakudo to
  use it.

- [x] Harden dirty preserved snapshot behavior.
  Add size and content guardrails before `git add -A` and auto-commit.
  The first version should at minimum detect oversized snapshots and surface a
  review-required outcome rather than silently committing everything.

- [x] Keep `.gitignore` behavior intact.
  Do not reimplement Git ignore rules; add Bakudo-specific snapshot guardrails
  on top.

### Acceptance Criteria

- Path and branch resolution logic is no longer duplicated across runner,
  worktree, and candidate code.
- Oversized or suspicious preserved snapshots do not silently get auto-committed.
- Worktree state remains visible in the ledger and TUI.

### Verification

- Add tests for branch formatting and worktree path extraction logic.
- Add runtime tests for preserved dirty worktree handling.
- If `abox` changes are required, run `just integration-test`.

## Phase 5: Pre-Merge Verification for Autonomous Apply

### Outcome

`CandidatePolicy::AutoApply` should mean "apply automatically after clean
verification", not merely "merge immediately because the worker said it was
done".

### Files

- `crates/bakudo-daemon/src/worktree.rs`
- `crates/bakudo-daemon/src/session_controller.rs`
- `crates/bakudo-core/src/config.rs`
- `crates/bakudo-core/src/mission.rs`
- `tests/runtime.rs`

### Implementation

- [x] Introduce a verification step before autonomous merge.
  The host should spin a fresh ephemeral `abox` run against the merged result
  or the preserved worktree candidate and run a configured verification command.

- [x] Make verification policy configurable.
  The initial config can be repo-level and explicit, for example a list of
  commands or one command string for autonomous candidate verification.

- [x] On verification failure, downgrade the worktree outcome from
  auto-mergeable to review-required or conflict-like preserved state.

- [x] Surface verification outcome in `RunSummary`, trace bundles, and TUI
  completion messaging.

### Acceptance Criteria

- Auto-apply does not merge without passing verification when verification is
  configured.
- Verification failure is visible to the operator and leaves recoverable state.

### Verification

- Add runtime tests for verification success and failure.
- `just test-bakudo`
- `just integration-test` if the implementation spans `abox`

## Optional Phase 6: Cleanup and Decomposition

This phase is intentionally optional for this branch. Only start it if the
behavioral phases above are landed and verified.

Candidate cleanup work:

- extract mission tool handlers from `session_controller.rs`
- extract wake execution and scheduling helpers
- tighten type boundaries around mission banners and host snapshots
- reduce duplication between classic run and mission worker setup

This phase must not block the earlier product-facing phases.

## Suggested Commit Plan

Use small conventional commits in order:

1. `feat(runtime): improve worker handoff protocol and tui activity`
2. `feat(host): add structured mission introspection and steering`
3. `fix(mission): make missing durable state explicit and back off timeouts`
4. `fix(worktree): centralize path authority and harden preserved snapshots`
5. `feat(autonomy): verify auto-apply candidates before merge`

If an upstream `abox` change is needed, split it into a separate branch and
commit sequence first, then return to this Bakudo branch.

## Verification Bar For The Branch

Before the branch is considered done:

- `just test-bakudo`
- `just build-all`
- `just integration-test` if any `abox` contract changed
- Manual TUI smoke pass covering:
  - worker dispatch and completion
  - live progress rendering
  - host status questions
  - steering into an active mission
  - preserved worktree review flow
  - timeout backoff visibility

## Open Questions

These should be resolved early in implementation, not left until the end:

1. Should the first hand-off improvement use a richer transcript-only model, or
   should it immediately add a dedicated live activity panel?
2. Should timeout backoff scheduling live entirely in wake rows, or should part
   of the streak state also be written into `MissionState` for easier operator
   introspection?
3. What is the minimum viable verification command contract for auto-apply:
   one repo-global command, per-mission override, or both?
4. If structured worktree path reporting requires `abox` changes, what is the
   smallest stable upstream output contract that Bakudo can rely on?
