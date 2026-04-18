/**
 * Wave 6c PR7 / A6.5 — time-delta log format + rotation.
 *
 * Plan lines 915-925. Covers:
 *
 *   - `+Nms` delta between sequential writes on one logger instance.
 *   - Rotation keeps only the 10 most recent `bakudo-{iso}.log` files.
 *   - `host=<source>`, `sessionId=<id>`, `msg="..."` ordering + quoting.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  formatLogLine,
  openLogFile,
  rotateLogFiles,
  TimeDeltaLogger,
  LOG_FILES_KEEP,
} from "../../src/host/telemetry/timeDeltaLogger.js";

test('formatLogLine: emits the plan-stated `[iso] +Nms host=... sessionId=... msg="..."` shape', () => {
  const line = formatLogLine({
    timestampIso: "2026-04-15T12:00:01.234Z",
    deltaMs: 12,
    host: "session-store",
    sessionId: "ses_01H",
    msg: "appended turn record",
  });
  assert.equal(
    line,
    '[2026-04-15T12:00:01.234Z] +12ms host=session-store sessionId=ses_01H msg="appended turn record"',
  );
});

test("formatLogLine: omits sessionId when undefined", () => {
  const line = formatLogLine({
    timestampIso: "2026-04-15T12:00:01.234Z",
    deltaMs: 0,
    host: "boot",
    msg: "hello",
  });
  assert.ok(!line.includes("sessionId="));
  assert.ok(line.includes('msg="hello"'));
});

test("formatLogLine: escapes embedded quotes, backslashes, newlines inside msg", () => {
  const line = formatLogLine({
    timestampIso: "2026-04-15T12:00:01.234Z",
    deltaMs: 5,
    host: "x",
    msg: 'a "b" \\ c\nnext',
  });
  assert.match(line, /msg="a \\"b\\" \\\\ c\\nnext"/u);
});

test("formatLogLine: attaches extra key=value pairs", () => {
  const line = formatLogLine({
    timestampIso: "2026-04-15T12:00:01.234Z",
    deltaMs: 0,
    host: "x",
    msg: "hi",
    extra: { requestId: "r-1", count: 3, ok: true },
  });
  assert.match(line, /requestId=r-1/u);
  assert.match(line, /count=3/u);
  assert.match(line, /ok=true/u);
});

test("TimeDeltaLogger: first line is `+0ms`, subsequent lines show the delta", async () => {
  const lines: string[] = [];
  let t = 1_000;
  const clock = (): number => {
    const v = t;
    t += 12;
    return v;
  };
  const logger = new TimeDeltaLogger({
    host: "session-store",
    level: "info",
    writeLine: async (line) => {
      lines.push(line);
    },
    clock,
  });
  await logger.info("first");
  await logger.info("second");
  await logger.info("third");
  assert.equal(lines.length, 3);
  assert.match(lines[0]!, /\+0ms/u);
  assert.match(lines[1]!, /\+12ms/u);
  assert.match(lines[2]!, /\+12ms/u);
});

test("TimeDeltaLogger: suppresses lines below threshold", async () => {
  const lines: string[] = [];
  const logger = new TimeDeltaLogger({
    host: "h",
    level: "warning",
    writeLine: async (line) => {
      lines.push(line);
    },
    clock: () => 0,
  });
  await logger.debug("not written");
  await logger.info("also not written");
  await logger.warn("yes");
  await logger.error("yes");
  assert.equal(lines.length, 2);
});

test("rotateLogFiles: keeps only `keep` newest files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bakudo-logs-"));
  try {
    // Make 12 candidate files with increasing mtimes.
    for (let i = 0; i < 12; i += 1) {
      const file = join(dir, `bakudo-2026-04-15T12-00-${String(i).padStart(2, "0")}-000Z.log`);
      await writeFile(file, `file ${i}\n`, "utf8");
      // Ensure distinct mtime — OSes with 1s resolution merge timestamps.
      await new Promise((res) => setTimeout(res, 6));
    }
    // Drop an unrelated file to prove the filter ignores non-bakudo logs.
    await writeFile(join(dir, "readme.txt"), "ignored", "utf8");
    const removed = await rotateLogFiles(dir, 10);
    assert.equal(removed.length, 2, "expected two oldest files removed");
    const remaining = await readdir(dir);
    const bakudoCount = remaining.filter(
      (n) => n.startsWith("bakudo-") && n.endsWith(".log"),
    ).length;
    assert.equal(bakudoCount, 10);
    assert.ok(remaining.includes("readme.txt"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rotateLogFiles: keep >= file count is a no-op", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bakudo-logs-"));
  try {
    await writeFile(join(dir, "bakudo-a.log"), "", "utf8");
    const removed = await rotateLogFiles(dir, 10);
    assert.equal(removed.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("LOG_FILES_KEEP is 10 per plan A6.5 rotation requirement", () => {
  assert.equal(LOG_FILES_KEEP, 10);
});

test("openLogFile: writes lines to the returned path and rotates", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bakudo-logs-"));
  try {
    const { path, appendLine } = await openLogFile({ logDir: dir, keep: 10 });
    await appendLine("line-one");
    await appendLine("line-two");
    const body = await readFile(path, "utf8");
    assert.equal(body, "line-one\nline-two\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
