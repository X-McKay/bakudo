/**
 * Phase 5 PR7 — session-picker overlay renderer. Mirrors the shape of
 * `commandPaletteOverlayRenderer.test.ts`.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { SessionPickerPayload } from "../../src/host/appState.js";
import { stripAnsi } from "../../src/host/ansi.js";
import { initialHostAppState } from "../../src/host/appState.js";
import { reduceHost } from "../../src/host/reducer.js";
import { selectRenderFrame } from "../../src/host/renderModel.js";
import {
  filterSessionPickerItems,
  renderSessionPickerOverlayLines,
} from "../../src/host/renderers/sessionPickerOverlay.js";
import { renderTranscriptFrame } from "../../src/host/renderers/transcriptRenderer.js";
import { renderTranscriptFramePlain } from "../../src/host/renderers/plainRenderer.js";

const samplePayload = (overrides: Partial<SessionPickerPayload> = {}): SessionPickerPayload => ({
  items: [
    { sessionId: "11111111", label: "session-11111111 paused standard · alpha · 2025-06-03" },
    { sessionId: "22222222", label: "session-22222222 active plan · beta · 2025-06-02" },
    { sessionId: "33333333", label: "session-33333333 archived plan · charlie · 2025-06-01" },
  ],
  input: "",
  selectedIndex: 0,
  ...overrides,
});

test("renderSessionPickerOverlayLines: header and banner always present", () => {
  const lines = renderSessionPickerOverlayLines(samplePayload());
  assert.equal(lines[0], "> ");
  assert.equal(lines[1], "[session picker]");
});

test("renderSessionPickerOverlayLines: cursor marks selected row", () => {
  const lines = renderSessionPickerOverlayLines(samplePayload({ selectedIndex: 1 }));
  assert.ok(lines[2]?.startsWith("  ") && lines[2]?.includes("alpha"));
  assert.ok(lines[3]?.startsWith("❯") && lines[3]?.includes("beta"));
  assert.ok(lines[4]?.startsWith("  ") && lines[4]?.includes("charlie"));
});

test("renderSessionPickerOverlayLines: filter narrows the shown rows", () => {
  const lines = renderSessionPickerOverlayLines(samplePayload({ input: "charlie" }));
  const rowLines = lines.slice(2);
  assert.equal(rowLines.length, 1);
  assert.ok(rowLines[0]?.includes("charlie"));
});

test("renderSessionPickerOverlayLines: no matches emits placeholder", () => {
  const lines = renderSessionPickerOverlayLines(samplePayload({ input: "zzzzz" }));
  const rowLines = lines.slice(2);
  assert.deepEqual(rowLines, ["(no matches)"]);
});

test("renderSessionPickerOverlayLines: echoes the filter input", () => {
  const lines = renderSessionPickerOverlayLines(samplePayload({ input: "beta" }));
  assert.equal(lines[0], "> beta");
});

test("renderSessionPickerOverlayLines: fuzzy subsequence match works", () => {
  // "alp" — narrower than "aph" so only the alpha row matches. "aph" would
  // also match "...archived plan ... charlie" because its label carries
  // 'a' (archived[0]), 'p' (plan[0]), 'h' (charlie[4]).
  const lines = renderSessionPickerOverlayLines(samplePayload({ input: "alp" }));
  const rowLines = lines.slice(2);
  assert.equal(rowLines.length, 1);
  assert.ok(rowLines[0]?.includes("alpha"));
});

test("renderSessionPickerOverlayLines: selectedIndex clamps to visible range", () => {
  const lines = renderSessionPickerOverlayLines(
    samplePayload({ input: "charlie", selectedIndex: 9 }),
  );
  const rowLines = lines.slice(2);
  assert.equal(rowLines.length, 1);
  assert.ok(rowLines[0]?.startsWith("❯"));
});

test("filterSessionPickerItems: returns full list when input empty", () => {
  const payload = samplePayload();
  assert.equal(filterSessionPickerItems(payload).length, payload.items.length);
});

test("transcript renderer: session picker overlay round-trips through selectRenderFrame", () => {
  const state = reduceHost(initialHostAppState(), {
    type: "enqueue_prompt",
    prompt: {
      id: "p1",
      kind: "session_picker",
      payload: samplePayload({ input: "", selectedIndex: 0 }),
    },
  });
  const frame = selectRenderFrame({ state, transcript: [] });
  const lines = renderTranscriptFrame(frame).map(stripAnsi);
  assert.ok(lines.some((line) => line === "> "));
  assert.ok(lines.some((line) => line === "[session picker]"));
  assert.ok(lines.some((line) => line.startsWith("❯") && line.includes("alpha")));
});

test("plain renderer: session picker overlay emits plain strings", () => {
  const state = reduceHost(initialHostAppState(), {
    type: "enqueue_prompt",
    prompt: {
      id: "p1",
      kind: "session_picker",
      payload: samplePayload({ input: "beta", selectedIndex: 0 }),
    },
  });
  const frame = selectRenderFrame({ state, transcript: [] });
  const lines = renderTranscriptFramePlain(frame);
  assert.ok(lines.includes("> beta"));
  assert.ok(lines.includes("[session picker]"));
  assert.ok(lines.some((line) => line.includes("beta") && line.startsWith("❯")));
});
