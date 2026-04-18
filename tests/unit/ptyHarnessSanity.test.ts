/**
 * W6E cleanup PR15-NB1 — sanity check for the PTY harness.
 *
 * The golden tests that rely on `runUnderPty` will skip cleanly when
 * `script(1)` is absent, which makes it possible for the harness itself to
 * break without any existing test noticing. This test invokes the harness
 * against `node --version` — the simplest command that exists on every
 * host where the suite runs — and asserts the harness either completed
 * successfully (bytes present) or skipped explicitly. An `error` result
 * means the harness is broken and must not silently mask golden coverage.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { runUnderPty } from "../helpers/ptyHarness.js";

test("ptyHarness: runUnderPty node --version completes ok or skips cleanly", async () => {
  const result = await runUnderPty({ name: "node-version", input: ["--version"] });
  if (result.status === "skipped") {
    return;
  }
  assert.equal(
    result.status,
    "ok",
    `expected ok or skipped but got ${result.status}: ${"reason" in result ? result.reason : ""}`,
  );
  if (result.status === "ok") {
    assert.ok(result.bytes.length > 0, "ok result must carry non-empty captured bytes");
  }
});
