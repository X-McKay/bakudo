/**
 * Phase 6 W1 — CLI plumbing for the `--ui preview|default|legacy` flag.
 *
 * The acceptance criteria (plan 06 lines 144-147) require:
 *
 *   1. cutover is staged and reversible
 *   2. there is no ambiguity about how to revert temporarily
 *
 * These tests cover the flag's parser contract, its error surface for
 * invalid values, and the `--ui=value` / `--ui value` equivalence. The
 * doctor integration (which persists the active mode into the envelope)
 * is covered separately in `tests/integration/doctor-command.test.ts`.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { parseHostArgs } from "../../src/hostCli.js";
import { getActiveUiMode, resetActiveUiMode } from "../../src/host/uiMode.js";
import { buildUsageLines } from "../../src/host/usage.js";

test("cli: --ui preview is parsed into args.uiMode", () => {
  const args = parseHostArgs(["build", "ship it", "--ui", "preview"]);
  assert.equal(args.uiMode, "preview");
});

test("cli: --ui=default (equals-form) is parsed into args.uiMode", () => {
  const args = parseHostArgs(["plan", "inspect repo", "--ui=default"]);
  assert.equal(args.uiMode, "default");
});

test("cli: --ui legacy is parsed (plan rule 1 — legacy not removed in Phase 6)", () => {
  const args = parseHostArgs(["run", "whatever", "--ui", "legacy"]);
  assert.equal(args.uiMode, "legacy");
});

test("cli: --ui hidden is parsed (stage C marker)", () => {
  const args = parseHostArgs(["build", "thing", "--ui", "hidden"]);
  assert.equal(args.uiMode, "hidden");
});

test("cli: --ui without a value throws 'missing value for --ui'", () => {
  assert.throws(() => parseHostArgs(["build", "thing", "--ui"]), /missing value for --ui/u);
});

test("cli: --ui with an unknown value throws and names the bad input", () => {
  assert.throws(
    () => parseHostArgs(["build", "thing", "--ui", "xyz"]),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /invalid --ui/u);
      assert.match(err.message, /xyz/u);
      // The error must enumerate the acceptable modes so the user can
      // recover without reading the source.
      assert.match(err.message, /preview/u);
      assert.match(err.message, /default/u);
      assert.match(err.message, /legacy/u);
      return true;
    },
  );
});

test("cli: args.uiMode is undefined when the flag is omitted", () => {
  // Undefined = "use the compile-time default". Explicit contract so the
  // host can distinguish "user picked default" from "user didn't ask".
  const args = parseHostArgs(["build", "thing"]);
  assert.equal(args.uiMode, undefined);
});

test("cli: --ui flag is independent of --experimental and Copilot flags", () => {
  const args = parseHostArgs([
    "build",
    "ship it",
    "--experimental",
    "--allow-all-tools",
    "--ui",
    "preview",
  ]);
  assert.equal(args.uiMode, "preview");
  assert.equal(args.experimental, true);
  assert.equal(args.copilot.allowAllTools, true);
});

test("cli: resetActiveUiMode restores the default mode between invocations", () => {
  // Simulates the finalizer in runHostCli: after a --ui legacy invocation
  // returns, a follow-up invocation in the same process must start clean.
  resetActiveUiMode();
  assert.equal(getActiveUiMode(), "default");
});

test("help: --help output includes a 'Rollout' section documenting --ui modes", () => {
  // Plan 06 hard rule 2 requires the rollback flag be documented.
  const body = buildUsageLines().join("\n");
  assert.match(body, /Rollout/u);
  assert.match(body, /--ui preview/u);
  assert.match(body, /--ui default/u);
});

test("help: --help output advertises --ui legacy in Stage B (rollback path visible)", () => {
  // Plan 06 stage B keeps --ui legacy visible. Stage C flips
  // LEGACY_HIDDEN_IN_HELP; when that happens, this assertion flips.
  const body = buildUsageLines().join("\n");
  assert.match(body, /--ui legacy/u);
});
