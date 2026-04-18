/**
 * Phase 5 PR7 — command-palette overlay renderer. Checks the plain-text
 * line projection (the transcript renderer wraps these in `tone.info`).
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { CommandPaletteRequest } from "../../src/host/appState.js";
import { stripAnsi } from "../../src/host/ansi.js";
import { initialHostAppState } from "../../src/host/appState.js";
import { reduceHost } from "../../src/host/reducer.js";
import { selectRenderFrame } from "../../src/host/renderModel.js";
import {
  filterPaletteItems,
  renderCommandPaletteOverlayLines,
} from "../../src/host/renderers/commandPaletteOverlay.js";
import { renderTranscriptFrame } from "../../src/host/renderers/transcriptRenderer.js";
import { renderTranscriptFramePlain } from "../../src/host/renderers/plainRenderer.js";

const sampleRequest = (overrides: Partial<CommandPaletteRequest> = {}): CommandPaletteRequest => ({
  items: [
    { name: "alpha", description: "first command" },
    { name: "beta", description: "second command" },
    { name: "charlie", description: "third command" },
  ],
  input: "",
  selectedIndex: 0,
  ...overrides,
});

test("renderCommandPaletteOverlayLines: header and banner always present", () => {
  const lines = renderCommandPaletteOverlayLines(sampleRequest());
  assert.equal(lines[0], "> ");
  assert.equal(lines[1], "[command palette]");
});

test("renderCommandPaletteOverlayLines: cursor marks the selected row", () => {
  const lines = renderCommandPaletteOverlayLines(sampleRequest({ selectedIndex: 1 }));
  // lines[0] is header, lines[1] is banner, lines[2..] are rows.
  assert.equal(lines[2], "  /alpha  — first command");
  assert.equal(lines[3], "❯ /beta  — second command");
  assert.equal(lines[4], "  /charlie  — third command");
});

test("renderCommandPaletteOverlayLines: echoes the current filter input", () => {
  const lines = renderCommandPaletteOverlayLines(sampleRequest({ input: "be" }));
  assert.equal(lines[0], "> be");
});

test("renderCommandPaletteOverlayLines: filter narrows the shown rows", () => {
  const lines = renderCommandPaletteOverlayLines(sampleRequest({ input: "ch" }));
  // Only charlie matches.
  const rowLines = lines.slice(2);
  assert.equal(rowLines.length, 1);
  assert.ok(rowLines[0]?.includes("/charlie"));
});

test("renderCommandPaletteOverlayLines: fuzzy subsequence match", () => {
  const lines = renderCommandPaletteOverlayLines(sampleRequest({ input: "ara" }));
  // "ara" subsequence matches "alpha"? a->l->p->h->a, chars needed are a,r,a
  // — no r in alpha, so no match.
  // But "ara" should fuzzy-match "charlie"? c,h,a,r,l,i,e — a,r,a needs second a after r; no.
  // None match — empty list with (no matches) line.
  const rowLines = lines.slice(2);
  assert.deepEqual(rowLines, ["(no matches)"]);
});

test("renderCommandPaletteOverlayLines: fuzzy match supports gaps", () => {
  const lines = renderCommandPaletteOverlayLines(sampleRequest({ input: "cle" }));
  // c->h->a->r->l->i->e — c, then l after c, then e after l. Match.
  const rowLines = lines.slice(2);
  assert.equal(rowLines.length, 1);
  assert.ok(rowLines[0]?.includes("/charlie"));
});

test("renderCommandPaletteOverlayLines: selectedIndex clamps to visible range", () => {
  const lines = renderCommandPaletteOverlayLines(sampleRequest({ input: "alp", selectedIndex: 5 }));
  // Only alpha matches; cursor should still appear on that single row.
  const rowLines = lines.slice(2);
  assert.equal(rowLines.length, 1);
  assert.ok(rowLines[0]?.startsWith("❯"));
});

test("filterPaletteItems: returns full list when input is empty", () => {
  const request = sampleRequest();
  assert.equal(filterPaletteItems(request).length, request.items.length);
});

test("transcript renderer: palette overlay round-trips through selectRenderFrame", () => {
  const state = reduceHost(initialHostAppState(), {
    type: "enqueue_prompt",
    prompt: {
      id: "p1",
      kind: "command_palette",
      payload: sampleRequest({ input: "al", selectedIndex: 0 }),
    },
  });
  const frame = selectRenderFrame({ state, transcript: [] });
  const lines = renderTranscriptFrame(frame).map(stripAnsi);
  assert.ok(lines.some((line) => line === "> al"));
  assert.ok(lines.some((line) => line === "[command palette]"));
  assert.ok(lines.some((line) => line.startsWith("❯") && line.includes("/alpha")));
});

test("plain renderer: palette overlay emits plain strings", () => {
  const state = reduceHost(initialHostAppState(), {
    type: "enqueue_prompt",
    prompt: {
      id: "p1",
      kind: "command_palette",
      payload: sampleRequest({ input: "", selectedIndex: 2 }),
    },
  });
  const frame = selectRenderFrame({ state, transcript: [] });
  const lines = renderTranscriptFramePlain(frame);
  assert.ok(lines.includes("> "));
  assert.ok(lines.includes("[command palette]"));
  assert.ok(lines.some((line) => line === "❯ /charlie  — third command"));
});
