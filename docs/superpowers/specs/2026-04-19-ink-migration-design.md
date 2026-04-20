# Ink migration design

**Status:** Approved 2026-04-19
**Scope:** Replace bakudo's custom ANSI `TtyBackend` with an Ink-based interactive renderer. Land P1 composer polish in the same effort. Retire `TtyBackend` entirely.
**Non-scope:** `PlainBackend` / `JsonBackend` behavior, the orchestrator/worker pipeline, token/context accounting (P2), anchored popover positioning (P2), autocomplete (`/`, `@`) (P2), persisted history (P2).

---

## Problem

bakudo's interactive shell is a string-printer, not a TUI. `TtyBackend` builds a full frame as `string[]` via `renderTranscriptFrame()`, clears the screen, and reprints on each tick. There is no widget tree, no managed input, no spinner during dispatch, and no popover surface for overlays. The most recent commit (`8c52ceb`) landed color/theme plumbing but did not change the renderer architecture. Gaps observed in live tui-use sessions:

- Naked `> ` prompt, no border or metadata row.
- Event-kind labels leak into transcript output (`· version bakudo 0.2.0`).
- Static footer hints — never adapts to context.
- `/palette` dispatches but no overlay paints.
- No activity indicator during sandbox runs.
- Until `05779d8` (2026-04-19), the default alt-screen path was broken by a raw-mode + readline collision; `BAKUDO_NO_ALT_SCREEN=1` was required to type anything.

OpenCode (`@opentui/core` + SolidJS) and Claude Code (Ink + React) both operate at a widget-tree level. From inside a string-concatenation renderer bakudo cannot reach parity.

## Goals

1. Mount bakudo's interactive UI as an Ink component tree.
2. Replace `readline.question()` with an in-tree composer that owns stdin via `useInput`.
3. Move the per-turn event loop into a React effect so state updates drive redraws (no imperative `rerender(<App frame={...}/>)`).
4. Deliver the P1 visible upgrades: left-rail composer, metadata row, dynamic footer, cleaner transcript gutters, spinner during dispatch.
5. Preserve the existing reducer, `promptQueue` / `promptResolvers`, `sessionController`, signal-handler registry, and all 1600+ tests that run through `PlainBackend` / `JsonBackend`.

## Non-goals (P2+)

- Anchored popovers for `/palette` and `@`/`/` autocomplete.
- Persisted command history (XDG).
- Real token/context % in the footer (needs usage event stream threaded through the reducer).
- Hard cancellation of an in-flight `abox` invocation.
- Transcript virtualization (adopt OpenCode's 100-message cap when transcripts grow).

---

## Architecture

External store + stateless view. One mount, many state-driven redraws. Confirmed against Claude Code (`src/state/store.ts`, `src/state/AppState.tsx` using `useSyncExternalStore`) and OpenCode (`context/sync.tsx` — `createStore` + one big event-to-store reducer).

```
runInteractiveShell():
  store   = createHostStore(reduceHost, initialHostAppState)
  backend = selectRendererBackend()      // Ink | Plain | Json

  if Ink:
    instance = render(<App store={store} config={…}/>)
    registerCleanupHandler(() => instance.unmount())
    await instance.waitUntilExit()
  else:
    /* Plain / Json keep today's imperative drive — both non-interactive */
```

Inside the tree, one `<App/>` mounts `<Header/> <Transcript/> <OverlayStack/> <Composer/> <Footer/>` plus a renderless `<TurnDriver/>`. Components subscribe to state via `useAppState(selector)` backed by `useSyncExternalStore`. They do **not** consume a pre-baked `RenderFrame`; they read the slices they need directly so the composer can render `composer.mode === 'plan'` as a styled chip instead of a pre-formatted string.

**Deliberately rejected:** `backend.render(frame)` calling `rerender(<App frame={frame}/>)` every tick. Neither reference codebase does this; it fights Ink's reconciler and doubles the scheduler.

**Deliberately rejected:** `backend.nextInput(): Promise<string>` awaited by an outer while-loop. Creates two event loops (the promise seam + Ink's own), makes raw-mode handoff fragile, and makes mid-turn SIGINT hard to reason about. The turn loop moves into `<TurnDriver/>` as a `useEffect` async generator — the same shape Claude Code uses in `REPL.tsx`.

## State & frame model

`RenderFrame`'s role narrows. It remains the single input to `PlainBackend` / `JsonBackend`. Ink components bypass it and read state directly.

**Moved into `HostAppState` (from `TickDeps`):**
- `transcript: TranscriptItem[]` — reducer gains `append_user`, `append_assistant`, `append_event`, `append_output`, `append_review`, `clear_transcript` actions.

**Added to `HostAppState`:**
- `composer.model`, `composer.agent`, `composer.provider` — display strings sourced from merged config, refreshed on `/model` changes.
- `dispatch: { inFlight: false } | { inFlight: true, startedAt: number, label: string, detail?: string }` — drives the spinner and disables the composer. (Grep the reducer first — if an equivalent field already exists under another name, reuse it.)
- `pendingSubmit?: { seq: number; text: string }` — set by the composer on Enter; watched by `<TurnDriver/>`.
- `shouldExit?: { code: number }` — set by exit-class commands and SIGINT-after-idle; watched by `<App/>`.

**Unchanged:**
- `TranscriptItem` union. The `kind: "event"` branch keeps `label` + optional `detail`; Ink renders it with a tone symbol instead of `· ${label}`.
- `HostOverlay` union.
- `selectRenderFrame()` — still powers Plain / Json.

## Component tree

```
<App store config>
  <StoreProvider>
    <Box flexDirection="column" height="100%">
      <Header/>
      <Box flexGrow={1}><Transcript/></Box>
      <OverlayStack/>
      <Composer/>
      <Footer/>
    </Box>
    <TurnDriver/>        // renderless
  </StoreProvider>
</App>
```

- **`<Header/>`** — title, mode chip (PLAN/STD/AUTO tinted from theme), dim session label, repo label. Width-responsive truncation of session id. No border.
- **`<Transcript/>`** — maps over `state.transcript`. Per-item components: `<UserMessage/>` (dim `›` gutter), `<AssistantMessage/>` (dim `•` gutter, tone-colored text), `<EventLine/>` (tone symbol + detail; no more `· kind` leak), `<OutputBlock/>` (indented dim multiline), `<ReviewCard/>` (status symbol + outcome + `→ nextAction`). No virtualization in P1.
- **`<Composer/>`** — left-rail `┃`/`╹` border via Ink custom box chars, color tinted to mode. Custom `useInput`-based text entry (~150 LoC, single-line in P1). Metadata row beneath: `mode · model · agent · PROMPT|AUTO`, muted `·` separators. When `state.dispatch.inFlight`: input disabled, spinner + `{label} · {elapsed}` replaces placeholder, `Esc to cancel` shown.
- **`<Footer/>`** — single dim line. Default: `[/] commands  [?] help  [Ctrl+C] exit`. Context-aware: overlays swap their own hints; inspect screen shows scroll hints. Right-aligned `context —%` placeholder until P2.
- **`<OverlayStack/>`** — `switch(overlay?.kind)` into one of seven overlay components. Each renders inline above the composer with a rounded `<Box borderStyle="round"/>`; anchored positioning is P2.
- **`<Spinner/>`** — Braille `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` via `useEffect` + `setInterval`, ~30 LoC. Reusable.
- **`<TurnDriver/>`** — one `useEffect` on `state.pendingSubmit.seq`. Body is an async function that runs the existing pipeline (`registry.dispatch` → `answerHeadPrompt` → `dispatchThroughController` → `executePromptFromResolution`) with an `AbortController`. Dispatches store actions as progress arrives. Always closes with `dispatch_finished` + `clear_pending_submit`.

## Input pump & turn driver

Per-keystroke state stays **local** to `<Composer/>` (`useState`) — only submits become store actions. `<Composer/>`'s `useInput` branches on `state.promptQueue[0]?.kind`:

- `approval_prompt` → capture `1`|`2`|`3`|`4`|`Esc`|`Enter`, arrows cycle `approvalDialogCursor`, on answer call `answerPrompt(head.id, choice)`.
- other prompts → overlay handles keys; composer disabled.
- undefined → normal text entry. Enter → `store.dispatch({type:'submit', text})`.

**`StoreDeps` adapter** (migration bridge): today's ~30 command handlers mutate `deps.transcript.push(item)` and read `deps.appState.xxx`. Porting all 30 to typed actions is out of scope. `StoreDeps` wraps the store with a `TickDeps`-shaped facade: `.transcript.push(item)` dispatches `{type:'append_transcript', item}`; `.appState` is a getter returning `store.getState()`. The ~6 sites that today reassign `deps.appState = newState` get ported to `store.dispatch(action)`. Remaining debt (handlers still calling `.push`) is explicit and incrementally paid down.

**Cancellation:**
- `signalHandlers.ts` dispatches `{type:'cancel'}` on SIGINT.
- Reducer: if head prompt exists → cancel it (today's behavior); else set `shouldExit`.
- `<App/>` watches `shouldExit`, calls `instance.unmount()`.
- Mid-turn: `<TurnDriver/>` holds an `AbortController`; reducer's cancel action sets a signal the effect's cleanup triggers. For P1, `executePromptFromResolution` gets an optional `signal` threaded into its outermost `await` only. Hard cancel of an in-flight `abox` invocation is P2 (today's worker has no cancellation contract either → no regression).

**Lock-ins preserved:**
- 2 (SIGINT LIFO cleanup) — unchanged.
- 3 (keybinding registry + reserved keys) — composer cannot remap `Ctrl+C` / `Enter` / `/` / `Esc` / `Tab`.
- 8 (status line always present) — footer component always mounted.
- 9 (promise-based dialog launchers) — `promptQueue` + `promptResolvers` untouched.
- 15 (stay custom ANSI) — explicitly overturned by this decision; document the revision here and update `plans/bakudo-ux/handoffs/phase-5.md` when this lands.

## Files

**Add (~22 files, ~1000 LoC):**
- `src/host/store/{index.ts,actions.ts}`
- `src/host/renderers/inkBackend.ts`
- `src/host/renderers/ink/{App,StoreProvider,Header,Transcript,Composer,Footer,Spinner,OverlayStack,TurnDriver}.tsx`
- `src/host/renderers/ink/transcript/{UserMessage,AssistantMessage,EventLine,OutputBlock,ReviewCard}.tsx`
- `src/host/renderers/ink/overlays/{CommandPalette,Approval,ApprovalPrompt,QuickHelp,SessionPicker,TimelinePicker,ResumeConfirm}Overlay.tsx`
- `src/host/renderers/ink/hooks/{useAppState,useInputLine}.ts`
- `tests/unit/host/store.test.ts`
- `tests/unit/host/renderers/ink/{header,transcript,composer,footer,overlayStack,spinner,turnDriver}.test.tsx`
- `tests/integration/ink-interaction.test.tsx`

**Modify (6 files):**
- `src/host/reducer.ts` — new action types
- `src/host/appState.ts` — new fields
- `src/host/rendererBackend.ts` — `selectRendererBackend` returns Ink | Plain | Json
- `src/host/interactive.ts` — shrinks to ~30 LoC bootstrap
- `src/host/signalHandlers.ts` — dispatch cancel action
- `tests/unit/reducer.test.ts` — new action cases

**Delete (6 files, ~500 LoC):**
- `src/host/renderers/ttyBackend.ts`
- `src/host/renderers/transcriptRenderer.ts`
- `src/host/renderers/approvalPromptCopy.ts` (content absorbed into `ApprovalPromptOverlay.tsx`)
- `src/host/renderers/commandPaletteOverlay.ts` (absorbed into `CommandPaletteOverlay.tsx`)
- `src/host/renderers/sessionPickerOverlay.ts` (absorbed into `SessionPickerOverlay.tsx`)
- `tests/unit/altScreen.test.ts`

Net: ~+500 LoC for a real widget tree + P1 polish.

**Tooling:**
- Add deps: `ink@^7.0.1`, `react@^19`.
- Add dev deps: `ink-testing-library`, `@types/react`.
- `tsconfig.json`: `"jsx": "react-jsx"`, `"jsxImportSource": "react"`.
- Test runner (`node --test dist/tests/**`) works on tsc's `.tsx → .js` output; no runner change.

## Migration order (4 commits on a branch, 1 PR on merge)

1. **Store + state model.** Add `createHostStore`, move `transcript` into `HostAppState`, add composer metadata / `dispatch` / `pendingSubmit` / `shouldExit` fields, update reducer + tests. `interactive.ts` still drives the old readline loop but reads/writes via the store. No visual change. All tests green.
2. **Ink backend stub.** Add deps + tsconfig, mount minimal `<App/>` that reproduces today's output verbatim. Flip `selectRendererBackend` to Ink. Delete `TtyBackend` + transcript renderer + `altScreen.test.ts`. Visual parity with today. Tests green.
3. **Turn driver + input inversion.** Move the while-loop into `<TurnDriver/>`. `<Composer/>` owns input via `useInput`. `interactive.ts` shrinks to a bootstrap. `signalHandlers.ts` dispatches cancel actions. Input model modernised. All integration tests through Plain/Json still cover the pipeline.
4. **P1 composer polish.** Left rail, metadata row, dynamic footer, spinner, cleaner transcript gutters. The visible upgrade. New component tests.

Each step is reversible and has a green-test gate.

## Risks

- **`ink-testing-library` / Ink 7 compatibility.** `ink-testing-library` lags Ink major bumps; verify a working version before starting commit 1. If no published release supports Ink 7, write a tiny local shim (the library is ~100 LoC).
- **React 19 + Node 22 interop.** Unlikely to bite (Ink 7 is already on React 19 in production CLI apps), but run `pnpm test` immediately after adding deps.
- **`StoreDeps` migration debt.** ~30 command handlers continue to push into `deps.transcript` via the facade. This is intentional — tracked as a follow-up epic for Phase 7. The facade is a temporary bridge, not permanent.
- **Lock-in 15 overturn.** The phase-5 handoff explicitly said "stay custom ANSI". This spec overturns that decision with the user's approval. Update `plans/bakudo-ux/handoffs/phase-5.md` to reference this spec when commit 4 lands so future maintainers see the revision trail.
- **Golden / regression tests that assert on raw bytes.** Audit needed during commit 2. `plain-mode.test.ts` is safe (hits `PlainBackend`). `tty-overlay-navigation.test.ts` is the canary; plan a migration to `ink-testing-library` or repoint at Plain if it's not TTY-specific.

## References

- Claude Code codebase: `src/state/store.ts`, `src/state/AppState.tsx`, `src/ink/root.ts`, `src/ink/hooks/use-input.ts`, `src/ink/components/AlternateScreen.tsx`, `src/screens/REPL.tsx`, `src/components/PromptInput/PromptInput.tsx`, `src/utils/gracefulShutdown.ts`.
- OpenCode codebase: `packages/opencode/src/cli/cmd/tui/context/sync.tsx` (store + reducer, lines 114–351), `context/sdk.tsx` (SSE batching, lines 40–72), `routes/session/index.tsx` (transcript render at 1064), `component/prompt/index.tsx` (submission at 767), `ui/dialog.tsx` (overlay stack at 66).
- Phase-5 handoff: `plans/bakudo-ux/handoffs/phase-5.md` — lock-ins 2, 3, 8, 9, 15.
- Prior P0 fix: commit `05779d8 fix(host): stop TtyBackend from toggling raw mode on alt-screen enter`.
