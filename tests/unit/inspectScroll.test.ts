import assert from "node:assert/strict";
import test from "node:test";

import {
  applyInspectWindow,
  formatAboveIndicator,
  formatBelowIndicator,
} from "../../src/host/inspectScroll.js";

/**
 * Phase 5 PR8 — Inspect pane windowing.
 *
 * The helpers are pure — each axiom here maps to a specific scroll gesture
 * documented in the plan doc Workstream 3 (Inspect scroll).
 */

const makeLines = (count: number): string[] =>
  Array.from({ length: count }, (_value, idx) => `L${idx + 1}`);

test("applyInspectWindow: returns full content verbatim when total <= height", () => {
  const lines = makeLines(5);
  const result = applyInspectWindow({ lines, offset: 0, height: 10 });
  assert.deepEqual(result.lines, lines);
  assert.equal(result.hiddenAbove, 0);
  assert.equal(result.hiddenBelow, 0);
  assert.equal(result.offset, 0);
});

test("applyInspectWindow: offset=0 at the top emits only a below indicator", () => {
  const lines = makeLines(20);
  const result = applyInspectWindow({ lines, offset: 0, height: 5 });
  // No above indicator reserved at offset=0; below indicator consumes 1 row.
  // So content = 4 rows + 1 below indicator = 5 total.
  assert.equal(result.lines.length, 5);
  assert.equal(result.lines[0], "L1");
  assert.equal(result.lines[3], "L4");
  assert.equal(result.lines[4], formatBelowIndicator(16));
  assert.equal(result.hiddenAbove, 0);
  assert.equal(result.hiddenBelow, 16);
});

test("applyInspectWindow: middle offset emits both above + below indicators", () => {
  const lines = makeLines(30);
  const result = applyInspectWindow({ lines, offset: 10, height: 5 });
  // above indicator + 3 content + below indicator = 5 total
  assert.equal(result.lines.length, 5);
  assert.equal(result.lines[0], formatAboveIndicator(10));
  assert.equal(result.lines[1], "L11");
  assert.equal(result.lines[3], "L13");
  assert.equal(result.lines[4], formatBelowIndicator(30 - 13));
});

test("applyInspectWindow: offset beyond end clamps to last row, emits only above indicator", () => {
  const lines = makeLines(10);
  const result = applyInspectWindow({ lines, offset: 999, height: 4 });
  // Clamps to offset=9; above indicator + L10 = 2 rows, no below indicator.
  assert.equal(result.offset, 9);
  assert.equal(result.lines[0], formatAboveIndicator(9));
  assert.equal(result.lines[result.lines.length - 1], "L10");
  assert.equal(result.hiddenBelow, 0);
});

test("applyInspectWindow: height=1 still returns at least one content row", () => {
  const lines = makeLines(10);
  const result = applyInspectWindow({ lines, offset: 3, height: 1 });
  // With height=1 we guarantee one content row even though indicators are
  // budgeted; this is the reducer's minimum-invariant.
  assert.equal(result.lines.length >= 1, true);
});

test("applyInspectWindow: negative offset clamps to 0 (no above indicator)", () => {
  const lines = makeLines(20);
  const result = applyInspectWindow({ lines, offset: -5, height: 6 });
  assert.equal(result.offset, 0);
  assert.equal(result.hiddenAbove, 0);
  assert.equal(result.lines[0], "L1");
});

test("applyInspectWindow: empty content returns empty window, zero hidden", () => {
  const result = applyInspectWindow({ lines: [], offset: 0, height: 10 });
  assert.deepEqual(result.lines, []);
  assert.equal(result.hiddenAbove, 0);
  assert.equal(result.hiddenBelow, 0);
});

test("applyInspectWindow: fractional height/offset are floored", () => {
  const lines = makeLines(10);
  const result = applyInspectWindow({ lines, offset: 2.9, height: 3.4 });
  // floor(offset)=2, floor(height)=3 → content slice starts at L3.
  assert.equal(result.offset, 2);
  // Should include L3 in the window.
  assert.ok(result.lines.includes("L3"));
});

test("formatAboveIndicator / formatBelowIndicator: stable string shape", () => {
  assert.equal(formatAboveIndicator(3), "↑ 3 more above (PgUp / Ctrl+U)");
  assert.equal(formatBelowIndicator(7), "↓ 7 more below (PgDn / Ctrl+D)");
});

test("applyInspectWindow: offset just below end keeps 1 above, 0 below", () => {
  const lines = makeLines(20);
  // Offset 15, height 5 → show L16..L20 (5 rows) with above indicator
  // → that would be 6 rows; the helper reserves 1 for the above indicator
  // and trims the content to 4 rows; no below indicator is needed.
  const result = applyInspectWindow({ lines, offset: 16, height: 5 });
  assert.equal(result.lines[0], formatAboveIndicator(16));
  assert.equal(result.hiddenBelow, 0);
});
