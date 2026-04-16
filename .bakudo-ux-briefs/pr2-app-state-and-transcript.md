# PR2 — App state, reducer, render model, and transcript renderer

You are an autonomous coding agent working in the bakudo repository. This brief is your complete spec.

## Working directory and branch

- Repo: `/home/al/git/bakudo-abox/bakudo/`
- Current branch: `feat/ux-phase1-pr2-app-state-transcript` (already created, stacked on `feat/ux-phase1-pr1-extract-hostcli`)
- Do NOT switch branches. Do NOT touch anything outside `bakudo/`.

## Goal

Replace the current `InteractiveDashboard` rendering path with a transcript-first render pipeline driven by an explicit app-state model and reducer.

This is PR2 of 4 in Phase 1 of the bakudo UX overhaul.

## What this PR DOES

1. Introduces `HostAppState` and a pure reducer.
2. Introduces a `RenderFrame` render model and two renderers (transcript + plain).
3. Wires the existing interactive shell loop to derive a `RenderFrame` from `HostAppState` and render it through the chosen renderer.
4. Removes `InteractiveDashboard` usage from the runtime path. The class file may stay (for the next PR to delete cleanly), but it is no longer invoked. Prefer to delete it now if no callers remain.

## What this PR does NOT do (reserved for PR3 / PR4)

- Do NOT add `/new`, `/resume`, `/inspect`, `/mode`, `/approve`, `/autopilot`, `/compact`, or any new commands.
- Do NOT add a unified command registry. The current `dispatchHostCommand` if/else chain stays. PR3 introduces the registry.
- Do NOT add `host-state.json` or any session-continuity persistence. PR3 owns that.
- Do NOT change session-per-prompt semantics. PR2 keeps existing behavior: each prompt creates a fresh session, exactly like today. PR3 reverses this.
- Do NOT add the `preAction` bootstrap, `memoize`, try-finally bootstrap, or `profileCheckpoint`. PR4 owns those.
- Do NOT add the migration loader or session-schema v2. PR3 owns that.
- Do NOT add the dialog queue. PR3 owns that.
- Do NOT add Zod or any new dependency.
- Do NOT touch `abox/`, `plans/`, or anything outside `bakudo/`.
- Do NOT introduce new abstractions beyond what this brief specifies.

## Spec — types (verbatim from the phase doc)

Place these in `src/host/appState.ts`:

```ts
export type HostScreen = "transcript" | "sessions" | "inspect" | "help";

export type ComposerMode = "build" | "plan";

export type InspectTab = "summary" | "review" | "artifacts" | "sandbox" | "logs";

export type HostAppState = {
  screen: HostScreen;
  composer: {
    mode: ComposerMode;
    autoApprove: boolean;
    text: string;
  };
  activeSessionId?: string;
  activeTurnId?: string;
  inspect: {
    sessionId?: string;
    turnId?: string;
    attemptId?: string;
    tab: InspectTab;
  };
  overlay?:
    | { kind: "command_palette" }
    | { kind: "session_picker" }
    | { kind: "approval"; message: string };
  notices: string[];
};
```

Also export an `initialHostAppState()` factory that returns:

```ts
{
  screen: "transcript",
  composer: { mode: "build", autoApprove: false, text: "" },
  inspect: { tab: "summary" },
  notices: [],
}
```

`activeSessionId`, `activeTurnId`, and the inspect IDs default undefined.

## Spec — reducer

Place in `src/host/reducer.ts`. Pure function, no side effects.

```ts
export type HostAction =
  | { type: "set_mode"; mode: ComposerMode }
  | { type: "set_auto_approve"; value: boolean }
  | { type: "set_composer_text"; text: string }
  | { type: "clear_composer_text" }
  | { type: "set_active_session"; sessionId: string | undefined; turnId?: string }
  | { type: "set_screen"; screen: HostScreen }
  | { type: "set_inspect_target"; sessionId?: string; turnId?: string; attemptId?: string; tab?: InspectTab }
  | { type: "open_overlay"; overlay: NonNullable<HostAppState["overlay"]> }
  | { type: "close_overlay" }
  | { type: "push_notice"; notice: string }
  | { type: "clear_notices" };

export const reduceHost = (state: HostAppState, action: HostAction): HostAppState => { ... };
```

Reducer rules:
- Pure: never mutate `state`; always return a new object (or `state` unchanged if nothing changes).
- `set_mode` / `set_auto_approve` / `set_composer_text` / `clear_composer_text` mutate only the `composer` slice.
- `set_active_session` updates `activeSessionId` and `activeTurnId` together. If `sessionId` is undefined, both fields clear.
- `set_screen` only changes `screen`.
- `set_inspect_target` updates the `inspect` slice; missing fields keep their prior value; if `tab` is omitted it stays.
- `open_overlay` replaces any existing overlay. `close_overlay` sets `overlay` to undefined.
- `push_notice` appends; `clear_notices` empties the list.
- Unknown action types are a TypeScript-impossible state — do not add a fallback at runtime; the discriminated union handles it.

## Spec — render model

Place in `src/host/renderModel.ts`.

```ts
export type FrameMode = "prompt" | "transcript";

export type TranscriptItem =
  | { kind: "user"; text: string; timestamp?: string }
  | { kind: "assistant"; text: string; tone?: "info" | "success" | "warning" | "error" }
  | { kind: "event"; label: string; detail?: string }
  | { kind: "review"; outcome: string; summary: string; nextAction?: string };

export type RenderFrame = {
  mode: FrameMode; // from 2026-04-15 second pass: "prompt" = composer accepts input; "transcript" = composer hidden, transcript frozen
  header: {
    title: string;
    mode: ComposerMode;
    sessionLabel: string;
    repoLabel?: string;
  };
  transcript: TranscriptItem[];
  footer: {
    hints: string[];
  };
  composer: {
    placeholder: string;
    mode: ComposerMode;
    autoApprove: boolean;
  };
  inspectPane?: {
    title: string;
    lines: string[];
  };
};
```

Provide a pure selector function:

```ts
export type FrameInputs = {
  state: HostAppState;
  transcript: TranscriptItem[];
  repoLabel?: string;
};

export const selectRenderFrame = (inputs: FrameInputs): RenderFrame => { ... };
```

Selector rules:
- `frame.mode` is `"transcript"` if any `state.overlay` is set OR `state.screen !== "transcript"`. Otherwise `"prompt"`.
- `header.title` is always `"Bakudo"`.
- `header.mode` is `state.composer.mode`.
- `header.sessionLabel` is `"session " + activeSessionId.slice(0, 8)` when set, otherwise `"no active session"`.
- `header.repoLabel` is the input's `repoLabel` (host shell already knows this).
- `composer.placeholder`: empty string for now (PR3 will compute it based on session state).
- `composer.mode` mirrors `state.composer.mode`.
- `composer.autoApprove` mirrors `state.composer.autoApprove`.
- `footer.hints`: `["[help]"]` initially when no active session, `["[inspect]", "[help]"]` when an active session exists. Keep it minimal — PR3 expands this.
- `inspectPane`: undefined for now (PR3 fills it in when `screen === "inspect"`).
- `transcript` echoes the input's `transcript` array unchanged.

## Spec — renderers

### `src/host/renderers/transcriptRenderer.ts`

Renders a `RenderFrame` to a TTY. Pure rendering — accept the frame and return a string array (one line per element). Caller writes to stdout.

```ts
export const renderTranscriptFrame = (frame: RenderFrame): string[] => { ... };
```

Rules:
- Output structure (in order): one header line, blank line, all transcript items, blank line, footer hints, the prompt (if `frame.mode === "prompt"`).
- Use existing helpers from `src/host/ansi.ts` (`paint`, `bold`, `dim`, `cyan`, `green`, `yellow`, `red`, `gray`) for color. Do NOT introduce new ANSI helpers.
- Header line format: `Bakudo  <mode>  <sessionLabel>[  <repoLabel>]`. Color the mode chip with the existing `renderModeChip` helper if possible; otherwise plain.
- Transcript items:
  - `user`: `dim("You: ") + text`
  - `assistant`: `bold("Bakudo: ") + text`, with tone tinting (info=cyan, success=green, warning=yellow, error=red, undefined=plain)
  - `event`: `dim("· " + label + (detail ? " " + detail : ""))`
  - `review`: `bold("Review: ") + outcome + " — " + summary + (nextAction ? " (next: " + nextAction + ")" : "")`
- Footer hints: `dim(hints.join("  "))`
- Prompt: `"> "` (no color). Only emit when `frame.mode === "prompt"`.

### `src/host/renderers/plainRenderer.ts`

Same shape but no ANSI codes. Used when `supportsAnsi()` returns false. Same line ordering.

```ts
export const renderTranscriptFramePlain = (frame: RenderFrame): string[] => { ... };
```

## Wiring

Modify `src/host/interactive.ts` (and possibly `src/host/dashboard.ts`):

- `runInteractiveShell` should hold a `HostAppState` (initial via `initialHostAppState()`) and a `TranscriptItem[]` history.
- On each tick, build a frame via `selectRenderFrame`, render with the appropriate renderer (TTY → transcript, non-TTY → plain), write to stdout.
- The current `InteractiveDashboard.render()` call site is replaced. Do not call `InteractiveDashboard` anymore from the runtime path.
- If `dashboard.ts` becomes fully unused, delete it. If something still imports it (a test, a stale re-export), leave it but mark it for PR3 deletion.
- For PR2, the transcript items emitted during a prompt-then-execute cycle should be:
  1. `{ kind: "user", text: <prompt> }` when the user enters the prompt
  2. `{ kind: "assistant", text: "Dispatching sandbox attempt.", tone: "info" }` at dispatch start
  3. `{ kind: "assistant", text: "Worker completed.", tone: "info" }` at completion (or `tone: "error"` on failure)
  4. `{ kind: "review", outcome, summary, nextAction }` when the review verdict is known
- These three placeholder lines satisfy "transcript-first" without doing the full progress-mapper work (that's PR4).
- Keep all existing non-interactive command paths (plain `bakudo build "..."`, `bakudo plan "..."`, etc.) unchanged.

## Quality gates (non-negotiable)

1. `cd /home/al/git/bakudo-abox/bakudo && mise run check` exits 0. The 7 pre-existing `any` warnings in test files are baseline.
2. `mise exec -- pnpm test` passes all existing tests + the new ones below.
3. No file > 400 lines.
4. NO new dependencies. `package.json` and `pnpm-lock.yaml` unchanged.
5. NO `--no-verify`, NO `--amend`.
6. Conventional commit. Use this commit message:

```
feat(host): add app state, reducer, render model, and transcript renderer

Replaces the InteractiveDashboard render path with a transcript-first
pipeline driven by HostAppState + reduceHost + selectRenderFrame +
transcriptRenderer/plainRenderer. Session-per-prompt semantics
preserved (PR3 reverses this). PR2 of 4 in Phase 1 of the bakudo UX
overhaul.
```

Add `Co-Authored-By: Claude Code <noreply@anthropic.com>`.

## Tests required

Create:
1. `tests/unit/hostReducer.test.ts` — at least one assertion per reducer action type, plus immutability assertions (e.g., `Object.freeze`-ed input still yields a valid output) and "unknown previous state survives unrelated actions" cases. Aim for 12+ assertions.
2. `tests/unit/renderModel.test.ts` — assertions for `selectRenderFrame`:
   - `frame.mode === "prompt"` when transcript screen & no overlay
   - `frame.mode === "transcript"` when overlay set
   - `frame.mode === "transcript"` when `screen === "inspect"`
   - header session label format with and without `activeSessionId`
   - footer hints differ based on `activeSessionId` presence
   - composer fields mirror state
3. `tests/unit/transcriptRenderer.test.ts` — assertions that strings appear in the output:
   - header line includes `"Bakudo"` and the mode
   - user/assistant/event/review items each render their identifying text
   - prompt `"> "` appears only in `frame.mode === "prompt"`

Plain renderer can share most of the test file (use a small parametrized helper).

## Working procedure

1. `cd /home/al/git/bakudo-abox/bakudo`. Confirm branch.
2. Read these files end-to-end first:
   - `src/host/interactive.ts`
   - `src/host/dashboard.ts`
   - `src/host/ansi.ts`
   - `src/host/io.ts`
   - `src/host/orchestration.ts` (just the `executeTask` integration point)
   - `src/hostCli.ts`
3. Plan the integration. Verify the wiring approach matches what's specified above.
4. Create the new files in this order:
   - `src/host/appState.ts`
   - `src/host/reducer.ts`
   - `src/host/renderModel.ts`
   - `src/host/renderers/transcriptRenderer.ts`
   - `src/host/renderers/plainRenderer.ts`
   After each file, run `mise exec -- pnpm build` to confirm TS compiles.
5. Create the test files; run them with `mise exec -- pnpm test` (must pass before wiring changes).
6. Modify `src/host/interactive.ts` to use the new pipeline. Delete or stop calling `InteractiveDashboard`.
7. Run `mise run check`. Must exit 0. Run `mise exec -- pnpm test` — all tests pass.
8. If anything fails, root-cause it. No `--no-verify`, no `--amend`.
9. `git add` only the new/modified source + test files. Do NOT `git add -A` (would pick up untracked `.bakudo/`). Commit with the message above.

## Final report

Return a structured report:
1. Files created/modified with line counts
2. `mise run check` exit code + warning summary
3. Test pass count (was 39/39 on main; expect more after PR2)
4. Commit SHA (`git log -1 --format=%H`)
5. Any deviations from this brief, with justification
6. Whether `dashboard.ts` was deleted or kept (and why)
7. Manual visual confirmation: capture the first ~10 lines of `bakudo` shell output (run `node ./dist/src/cli.js` non-interactively if possible, or paste a manual transcript) and confirm the dashboard box is gone

Begin now.
