/**
 * Phase 5 PR14 — TTY overlays do not break transcript rendering.
 *
 * Required assertion (plan `05-…hardening.md:289`): as the user walks
 * through the overlay stack — open command palette → overlay quick-help
 * → close → open timeline_picker → open an approval prompt and navigate
 * the cursor — the base transcript lines stay in every frame and no
 * ANSI corruption leaks into the rendered output.
 *
 * These tests are renderer-level (pure): they drive `reduceHost` to set
 * up each state, render via `renderTranscriptFrame`, and assert on the
 * resulting `string[]` frames after `stripAnsi`.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { ANSI_PATTERN, stripAnsi } from "../../src/host/ansi.js";
import {
  initialHostAppState,
  type ApprovalPromptRequest,
  type CommandPaletteRequest,
  type HostAppState,
  type SessionPickerPayload,
} from "../../src/host/appState.js";
import { reduceHost } from "../../src/host/reducer.js";
import { selectRenderFrame, type TranscriptItem } from "../../src/host/renderModel.js";
import { renderTranscriptFrame } from "../../src/host/renderers/transcriptRenderer.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TRANSCRIPT: TranscriptItem[] = [
  { kind: "user", text: "refactor the reducer" },
  { kind: "assistant", text: "Queued sandbox attempt.", tone: "info" },
  {
    kind: "review",
    outcome: "success",
    summary: "unit tests still pass",
    nextAction: "accept",
  },
];

const BASE_TRANSCRIPT_MARKERS: readonly RegExp[] = [
  /You: refactor the reducer/u,
  /Bakudo: Queued sandbox attempt/u,
  /Review: success/u,
];

const paletteRequest = (): CommandPaletteRequest => ({
  items: [
    { name: "alpha", description: "first cmd" },
    { name: "beta", description: "second cmd" },
  ],
  input: "",
  selectedIndex: 0,
});

const sessionPickerPayload = (): SessionPickerPayload => ({
  items: [
    { sessionId: "session-abc12345", label: "session-abc12345 — goal one" },
    { sessionId: "session-def67890", label: "session-def67890 — goal two" },
  ],
  input: "",
  selectedIndex: 0,
});

const approvalRequest = (): ApprovalPromptRequest => ({
  sessionId: "session-overlay-nav",
  turnId: "turn-1",
  attemptId: "attempt-1",
  tool: "shell",
  argument: "git status",
  policySnapshot: {
    agent: "standard",
    composerMode: "standard",
    autopilot: false,
  },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const renderLines = (state: HostAppState): string[] => {
  const frame = selectRenderFrame({ state, transcript: TRANSCRIPT });
  return renderTranscriptFrame(frame);
};

const assertNoAnsiCorruption = (rawLines: string[], label: string): void => {
  const raw = rawLines.join("\n");
  const stripped = stripAnsi(raw);
  // Round-trip invariant: stripping ANSI twice is idempotent.
  assert.equal(stripAnsi(stripped), stripped, `${label}: stripAnsi is idempotent`);
  // No unclosed/hanging ESC bytes in the stripped output.
  assert.equal(
    stripped.match(/\u001B/u),
    null,
    `${label}: stripped output has no bare ESC bytes (corruption)`,
  );
  // Every ANSI code in the raw output is a proper `CSI … m` SGR sequence
  // (what our ansi.ts wrappers emit). Any other \u001B would be corruption.
  const anyEscape = raw.match(/\u001B/gu);
  if (anyEscape !== null) {
    const matches = raw.match(ANSI_PATTERN) ?? [];
    assert.equal(
      matches.length,
      anyEscape.length,
      `${label}: every ESC byte is a proper SGR sequence (no partial/corrupted codes)`,
    );
  }
};

const assertBaseTranscriptPresent = (lines: string[], label: string): void => {
  const stripped = lines.map(stripAnsi).join("\n");
  for (const re of BASE_TRANSCRIPT_MARKERS) {
    assert.match(stripped, re, `${label}: base transcript marker ${re} missing`);
  }
};

const assertOverlayPresent = (lines: string[], marker: RegExp, label: string): void => {
  const stripped = lines.map(stripAnsi).join("\n");
  assert.match(stripped, marker, `${label}: overlay marker ${marker} missing`);
};

// ---------------------------------------------------------------------------
// Overlay walk — base → palette → quick_help → close → timeline → approval
// ---------------------------------------------------------------------------

test("base transcript renders without any overlay (baseline)", () => {
  const state = initialHostAppState();
  const lines = renderLines(state);
  assertNoAnsiCorruption(lines, "baseline");
  assertBaseTranscriptPresent(lines, "baseline");
});

test("open command palette: base transcript still present, palette rendered", () => {
  let state = initialHostAppState();
  state = reduceHost(state, {
    type: "enqueue_prompt",
    prompt: { id: "p-palette", kind: "command_palette", payload: paletteRequest() },
  });
  const lines = renderLines(state);
  assertNoAnsiCorruption(lines, "palette");
  assertBaseTranscriptPresent(lines, "palette");
  assertOverlayPresent(lines, /\[command palette\]/u, "palette");
  assertOverlayPresent(lines, /\/alpha/u, "palette");
});

test("quick-help over palette: help overlay visible, palette kind surfaced in heading, base transcript intact", () => {
  let state = initialHostAppState();
  state = reduceHost(state, {
    type: "enqueue_prompt",
    prompt: { id: "p-palette", kind: "command_palette", payload: paletteRequest() },
  });
  state = reduceHost(state, {
    type: "open_quick_help",
    context: "dialog",
    dialogKind: "command_palette",
  });
  const lines = renderLines(state);
  assertNoAnsiCorruption(lines, "quick-help-over-palette");
  assertBaseTranscriptPresent(lines, "quick-help-over-palette");
  // Quick-help heading acknowledges the dialog kind (see `buildQuickHelpContents`).
  assertOverlayPresent(lines, /Quick help .* dialog.*command_palette/u, "quick-help-over-palette");
  assertOverlayPresent(lines, /Press \? or Esc to dismiss\./u, "quick-help-over-palette");
});

test("close_quick_help reverts to the underlying palette overlay", () => {
  let state = initialHostAppState();
  state = reduceHost(state, {
    type: "enqueue_prompt",
    prompt: { id: "p-palette", kind: "command_palette", payload: paletteRequest() },
  });
  state = reduceHost(state, {
    type: "open_quick_help",
    context: "dialog",
    dialogKind: "command_palette",
  });
  state = reduceHost(state, { type: "close_quick_help" });

  const lines = renderLines(state);
  assertNoAnsiCorruption(lines, "close-quick-help");
  assertBaseTranscriptPresent(lines, "close-quick-help");
  assertOverlayPresent(lines, /\[command palette\]/u, "close-quick-help");
  // Help overlay is gone.
  const stripped = lines.map(stripAnsi).join("\n");
  assert.equal(stripped.match(/Quick help/u), null, "quick-help is gone after close");
});

test("cancel palette, then open timeline_picker: timeline overlay visible", () => {
  let state = initialHostAppState();
  state = reduceHost(state, {
    type: "enqueue_prompt",
    prompt: { id: "p-palette", kind: "command_palette", payload: paletteRequest() },
  });
  state = reduceHost(state, { type: "dequeue_prompt", id: "p-palette" });
  state = reduceHost(state, {
    type: "enqueue_prompt",
    prompt: { id: "p-timeline", kind: "timeline_picker", payload: {} },
  });

  const lines = renderLines(state);
  assertNoAnsiCorruption(lines, "timeline");
  assertBaseTranscriptPresent(lines, "timeline");
  assertOverlayPresent(lines, /\[timeline picker\]/u, "timeline");
});

test("approval prompt with cursor navigation: all four cursor positions render cleanly", () => {
  let state = initialHostAppState();
  state = reduceHost(state, {
    type: "enqueue_prompt",
    prompt: { id: "p-approval", kind: "approval_prompt", payload: approvalRequest() },
  });

  // Capture each frame as the cursor walks through positions 0..3.
  const framesAtCursor: string[][] = [];
  framesAtCursor.push(renderLines(state));
  for (let i = 0; i < 3; i += 1) {
    state = reduceHost(state, { type: "approval_dialog_cursor_down" });
    framesAtCursor.push(renderLines(state));
  }

  for (let i = 0; i < framesAtCursor.length; i += 1) {
    const label = `approval-cursor-${i}`;
    const frame = framesAtCursor[i]!;
    assertNoAnsiCorruption(frame, label);
    assertBaseTranscriptPresent(frame, label);
    assertOverlayPresent(frame, /Worker wants to run: /u, label);
    assertOverlayPresent(frame, /\[1\] allow once/u, label);
    assertOverlayPresent(frame, /\[2\] allow always/u, label);
    assertOverlayPresent(frame, /\[3\] deny/u, label);
    assertOverlayPresent(frame, /\[4\] show context/u, label);
    assertOverlayPresent(frame, /Choice \[1\/2\/3\/4\]/u, label);
  }

  // Sanity: cursor-0 and cursor-1 frames differ (the `❯` moved).
  assert.notEqual(
    framesAtCursor[0]!.join("\n"),
    framesAtCursor[1]!.join("\n"),
    "cursor navigation changes the frame",
  );
});

test("session picker overlay over transcript: picker renders, transcript preserved", () => {
  let state = initialHostAppState();
  state = reduceHost(state, {
    type: "enqueue_prompt",
    prompt: { id: "p-sessions", kind: "session_picker", payload: sessionPickerPayload() },
  });
  const lines = renderLines(state);
  assertNoAnsiCorruption(lines, "session-picker");
  assertBaseTranscriptPresent(lines, "session-picker");
  assertOverlayPresent(lines, /\[session picker\]/u, "session-picker");
  assertOverlayPresent(lines, /session-abc12345/u, "session-picker");
});

test("multi-overlay walk: palette → quick_help → close → timeline → approval — every frame is coherent", () => {
  let state = initialHostAppState();
  const assertSnapshot = (label: string, overlayMarker: RegExp): void => {
    const lines = renderLines(state);
    assertNoAnsiCorruption(lines, label);
    assertBaseTranscriptPresent(lines, label);
    assertOverlayPresent(lines, overlayMarker, label);
  };

  // Step 1 — open command palette.
  state = reduceHost(state, {
    type: "enqueue_prompt",
    prompt: { id: "p-palette", kind: "command_palette", payload: paletteRequest() },
  });
  assertSnapshot("walk.palette", /\[command palette\]/u);

  // Step 2 — overlay quick-help.
  state = reduceHost(state, {
    type: "open_quick_help",
    context: "dialog",
    dialogKind: "command_palette",
  });
  assertSnapshot("walk.quick-help", /Quick help/u);

  // Step 3 — close quick-help; palette is back.
  state = reduceHost(state, { type: "close_quick_help" });
  assertSnapshot("walk.after-close-help", /\[command palette\]/u);

  // Step 4 — cancel palette, open timeline picker.
  state = reduceHost(state, { type: "dequeue_prompt", id: "p-palette" });
  state = reduceHost(state, {
    type: "enqueue_prompt",
    prompt: { id: "p-timeline", kind: "timeline_picker", payload: {} },
  });
  assertSnapshot("walk.timeline", /\[timeline picker\]/u);

  // Step 5 — cancel timeline, enqueue approval, cycle cursor once.
  state = reduceHost(state, { type: "dequeue_prompt", id: "p-timeline" });
  state = reduceHost(state, {
    type: "enqueue_prompt",
    prompt: { id: "p-approval", kind: "approval_prompt", payload: approvalRequest() },
  });
  state = reduceHost(state, { type: "approval_dialog_cursor_down" });
  assertSnapshot("walk.approval", /Choice \[1\/2\/3\/4\]/u);

  // Final frame: base transcript still present alongside the approval overlay.
  const final = renderLines(state);
  assertBaseTranscriptPresent(final, "walk.final");
  assertOverlayPresent(final, /\[2\] allow always/u, "walk.final");
});

// ---------------------------------------------------------------------------
// Strip-ansi re-encoding sanity
// ---------------------------------------------------------------------------

test("every frame survives stripAnsi round-trip without losing content", () => {
  let state = initialHostAppState();
  state = reduceHost(state, {
    type: "enqueue_prompt",
    prompt: { id: "p1", kind: "approval_prompt", payload: approvalRequest() },
  });
  const raw = renderLines(state);
  const stripped = raw.map(stripAnsi);
  // The number of lines does not change.
  assert.equal(stripped.length, raw.length, "stripAnsi preserves line count");
  // The stripped content still matches every overlay marker.
  const joined = stripped.join("\n");
  assert.match(joined, /Worker wants to run/u);
  assert.match(joined, /Bakudo/u);
  // And the raw content's stripped form equals the directly-stripped output.
  assert.equal(stripAnsi(raw.join("\n")), stripped.join("\n"));
});
