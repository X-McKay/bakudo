/**
 * Phase 6 W1 — unit coverage for the rollout-mode registry.
 *
 * The plan's required assertions (plan 06 lines 94-147) are exercised 1:1:
 *
 *   - Stage A (preview) is a recognized mode.
 *   - Stage B (default) is the compile-time default.
 *   - Stage C marker (hidden) is recognized; the legacy flag stays usable
 *     even when hidden from help.
 *   - Stage D (legacy removed) is explicitly NOT advanced in Phase 6 — the
 *     `legacy` mode MUST still resolve at runtime.
 *   - Parse errors for unknown values fail fast with the original input in
 *     the message (`bakudo/src/host/parsing.ts`).
 *   - Active mode is observable at runtime (for doctor output) and
 *     resettable between invocations.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_UI_MODE,
  describeUiMode,
  getActiveUiMode,
  LEGACY_HIDDEN_IN_HELP,
  parseUiMode,
  resetActiveUiMode,
  setActiveUiMode,
  UI_MODES,
  type UiMode,
} from "../../src/host/uiMode.js";

test("uiMode: parses every documented rollout state", () => {
  // Plan 06 lines 94-126 enumerate four states. Every one MUST parse.
  for (const mode of UI_MODES) {
    const parsed = parseUiMode(mode);
    assert.equal(parsed, mode);
  }
});

test("uiMode: includes preview (stage A), default (stage B), legacy (B-C), hidden (C)", () => {
  const expected: UiMode[] = ["preview", "default", "legacy", "hidden"];
  for (const mode of expected) {
    assert.ok(
      UI_MODES.includes(mode),
      `expected ${mode} to be a recognized UI mode (plan 06 lines 94-126)`,
    );
  }
});

test("uiMode: parsing is case-insensitive and trims whitespace", () => {
  assert.equal(parseUiMode(" PREVIEW "), "preview");
  assert.equal(parseUiMode("Legacy"), "legacy");
  assert.equal(parseUiMode("DEFAULT"), "default");
});

test("uiMode: unknown values return undefined so the caller can throw with context", () => {
  assert.equal(parseUiMode("bogus"), undefined);
  assert.equal(parseUiMode(""), undefined);
  assert.equal(parseUiMode("new"), undefined);
});

test("uiMode: DEFAULT_UI_MODE is 'default' in Phase 6 (stage B)", () => {
  // Plan 06 line 129: do not remove legacy; plan lines 109-117: stage B
  // makes the new UX the default with `--ui legacy` as the escape hatch.
  assert.equal(DEFAULT_UI_MODE, "default");
});

test("uiMode: LEGACY_HIDDEN_IN_HELP is false in Phase 6 (stage B advertises the escape hatch)", () => {
  // Plan 06 hard rule 2: rollback flag must be documented for at least one
  // release cycle. Stage B keeps it in --help; Stage C flips this.
  assert.equal(LEGACY_HIDDEN_IN_HELP, false);
});

test("uiMode: 'legacy' mode is still resolvable (plan rule 1 — no removal in this phase)", () => {
  // Plan 06 line 129 forbids removing the legacy path in Phase 6.
  assert.ok(UI_MODES.includes("legacy"));
  assert.equal(parseUiMode("legacy"), "legacy");
});

test("uiMode: describeUiMode returns a stable human-readable line per mode", () => {
  for (const mode of UI_MODES) {
    const description = describeUiMode(mode);
    assert.equal(typeof description, "string");
    assert.ok(description.length > 0);
  }
  // Stable keywords — bug-report search keys off these.
  assert.match(describeUiMode("preview"), /preview/iu);
  assert.match(describeUiMode("default"), /default/iu);
  assert.match(describeUiMode("legacy"), /legacy/iu);
  assert.match(describeUiMode("hidden"), /hidden|default/iu);
});

test("uiMode: getActiveUiMode defaults to DEFAULT_UI_MODE before any set call", () => {
  resetActiveUiMode();
  assert.equal(getActiveUiMode(), DEFAULT_UI_MODE);
});

test("uiMode: setActiveUiMode + getActiveUiMode round-trip for every mode", () => {
  try {
    for (const mode of UI_MODES) {
      setActiveUiMode(mode);
      assert.equal(getActiveUiMode(), mode);
    }
  } finally {
    resetActiveUiMode();
  }
});

test("uiMode: resetActiveUiMode restores the default", () => {
  setActiveUiMode("preview");
  assert.equal(getActiveUiMode(), "preview");
  resetActiveUiMode();
  assert.equal(getActiveUiMode(), DEFAULT_UI_MODE);
});
