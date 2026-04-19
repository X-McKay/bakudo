# UX Realignment

**Goal:** Update the TUI/CLI rendering layer to surface the new control-plane vocabulary (sandbox states, merge strategies, host artifacts, output blocks) without breaking existing workflows.

**Non-Goals:** Do not change the underlying orchestration. This wave only changes how data is presented to the user.

## Pre-reads & Vocabulary
- Review the `sandboxLifecycleState` and `mergeStrategy` fields introduced in Waves 1 and 5.
- **Output Kind:** A new transcript item kind for rendering multi-line raw command output (like lists or help text) without prefixing every line with a bullet point.

## Dependencies
- **Requires:** Wave 5 (Persistence & UI). The UX layer needs the new state fields in the attempt record to render them.
- **Blocks:** None.

## Files to Modify

1. `src/host/renderModel.ts`
   - **Reason:** Add `output` to `TranscriptItemKind`. Update `FooterState` to include `sandboxState` and `activeSession`.
2. `src/host/renderers/transcriptRenderer.ts`
   - **Reason:** Render the new `output` kind as an indented block. Render the `review` card to show "Modified N files" instead of "exit 0".
3. `src/host/interactiveRenderLoop.ts`
   - **Reason:** Push captured stdout from commands as a single `output` item instead of N `event` items.
4. `src/host/commands/*.ts`
   - **Reason:** Convert multi-line `event` pushes to `output` pushes so lists look clean.
5. `src/host/printers.ts`
   - **Reason:** Fix the `logs` command to correctly parse v2 envelopes (`payload.taskId`) instead of expecting flat legacy objects.
6. `tests/fixtures/golden/*`
   - **Reason:** Regenerate all golden snapshots to match the new transcript rendering.

## Step-by-Step Implementation

### 1. Add the `output` Transcript Kind

Modify the render model to support raw output blocks.

```typescript
// src/host/renderModel.ts
export type TranscriptItem =
  | { kind: "user"; text: string }
  | { kind: "agent"; text: string }
  | { kind: "event"; label: string; detail?: string }
  | { kind: "output"; text: string } // <-- NEW
  | { kind: "review"; attemptId: string; status: string; summary: string }
  | { kind: "tool_call"; tool: string; args: string };
```

Update `transcriptRenderer.ts` to render it:

```typescript
// src/host/renderers/transcriptRenderer.ts
    case "output":
      return item.text
        .split("\n")
        .map((line) => `  ${dim(line)}`)
        .join("\n");
```

### 2. Fix the Interactive Shell Capture

Modify `interactiveRenderLoop.ts` to push stdout as a single `output` block instead of individual `event` lines.

```typescript
// src/host/interactiveRenderLoop.ts (around line 268)
// Replace:
// const recent = capture.lines.slice(-6);
// for (const captured of recent) {
//   deps.transcript.push({ kind: "event", label: parsed.command, detail: captured });
// }

// With:
if (capture.lines.length > 0) {
  deps.transcript.push({ kind: "output", text: capture.lines.join("\n") });
}
```

### 3. Update Slash Commands

In `src/host/commands/session.ts`, `tasks.ts`, `help.ts`, etc., replace `kind: "event"` pushes that span multiple lines with `kind: "output"`.

```typescript
// src/host/commands/session.ts
// Replace:
// transcript.push({ kind: "event", label: "sessions", detail: formattedList });
// With:
transcript.push({ kind: "output", text: formattedList });
```

### 4. Update the Footer

Modify `renderModel.ts` and the render loop to show the active session and key hints.

```typescript
// src/host/renderModel.ts
export type FooterState = {
  mode: ComposerMode;
  activeSessionId?: string;
  sandboxState?: string;
};

// In the renderer:
const hints = `[Tab] mode  [/] help  [Ctrl+C] exit`;
const session = state.activeSessionId ? ` • ${state.activeSessionId}` : "";
const sandbox = state.sandboxState ? ` • [${state.sandboxState}]` : "";
return `${bold(state.mode)}${session}${sandbox}  ${dim(hints)}`;
```

### 5. Fix Log Envelopes

The `logs` CLI command currently prints `undefined` for `taskId` because it expects legacy flat objects. Update `printers.ts` to read the v2 envelope.

```typescript
// src/host/printers.ts
// Inside printLogs:
const envelopes = await loadEventLog(sessionDir);
for (const env of envelopes) {
  const actor = env.actor || "system";
  const kind = env.kind;
  const detail = env.payload?.message || env.payload?.taskId || JSON.stringify(env.payload);
  
  console.log(`${dim(env.timestamp)}  ${bold(actor)}  ${kind}  ${detail}`);
}
```

### 6. Regenerate Golden Tests

Because the transcript rendering has changed (no more bullet points on lists, new footer hints), the golden tests will fail. 

Do **not** try to manually edit the `.txt` fixtures. Instead, run the test suite with the update flag:

```bash
UPDATE_GOLDENS=1 pnpm test
```

Review the git diff of the fixtures to ensure the changes match the expected UX improvements.

## Test Strategy
- **Unit:** Update `transcriptRenderer.test.ts` and `renderModel.test.ts` to assert on the new `output` kind and footer hints.
- **Golden:** Regenerate and verify visual correctness.

## Acceptance Criteria
- `pnpm test` passes completely.
- Running `bakudo sessions` in the interactive shell prints a clean indented block, not a list prefixed with `· sessions`.
- Running `bakudo logs` prints actual payload details instead of `undefined`.

## Rollback
If the `output` kind breaks critical event notifications, revert the specific slash command handlers to use `event`.
