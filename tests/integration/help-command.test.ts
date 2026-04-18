import assert from "node:assert/strict";
import test from "node:test";

import { withCapturedStdout } from "../../src/host/io.js";
import { buildHelpIndex, runHelpCli } from "../../src/host/commands/help.js";
import { KNOWN_HELP_TOPICS } from "../../src/host/helpTopicLoader.js";

const capture = (): { writer: { write: (chunk: string) => boolean }; chunks: string[] } => {
  const chunks: string[] = [];
  return {
    chunks,
    writer: {
      write: (chunk: string) => {
        chunks.push(chunk);
        return true;
      },
    },
  };
};

test("buildHelpIndex lists every Phase-5 topic", async () => {
  const lines = await buildHelpIndex();
  const body = lines.join("\n");
  for (const topic of KNOWN_HELP_TOPICS) {
    assert.ok(body.includes(topic), `missing topic ${topic} in help index`);
  }
});

test("runHelpCli (no topic): exits 0 and prints the index", async () => {
  const cap = capture();
  const code = await withCapturedStdout(cap.writer, () => runHelpCli({}));
  assert.equal(code, 0);
  assert.match(cap.chunks.join(""), /Topics:/u);
});

test("runHelpCli('config'): exits 0 and emits non-empty content", async () => {
  const cap = capture();
  const code = await withCapturedStdout(cap.writer, () => runHelpCli({ topic: "config" }));
  assert.equal(code, 0);
  const body = cap.chunks.join("");
  assert.ok(body.length > 0);
  assert.match(body, /bakudo config/u);
});

test("runHelpCli('hooks'): mentions host.approval_requested", async () => {
  const cap = capture();
  const code = await withCapturedStdout(cap.writer, () => runHelpCli({ topic: "hooks" }));
  assert.equal(code, 0);
  assert.match(cap.chunks.join(""), /host\.approval_requested/u);
});

test("runHelpCli('sandbox'): mentions --ephemeral", async () => {
  const cap = capture();
  const code = await withCapturedStdout(cap.writer, () => runHelpCli({ topic: "sandbox" }));
  assert.equal(code, 0);
  assert.match(cap.chunks.join(""), /--ephemeral/u);
});

test("runHelpCli('permissions'): covers deny-precedence", async () => {
  const cap = capture();
  const code = await withCapturedStdout(cap.writer, () => runHelpCli({ topic: "permissions" }));
  assert.equal(code, 0);
  assert.match(cap.chunks.join(""), /deny-precedence/iu);
});

test("runHelpCli('monitoring'): mentions bakudo doctor", async () => {
  const cap = capture();
  const code = await withCapturedStdout(cap.writer, () => runHelpCli({ topic: "monitoring" }));
  assert.equal(code, 0);
  assert.match(cap.chunks.join(""), /bakudo doctor/u);
});

test("runHelpCli(unknown topic): exits 1 and reports the error", async () => {
  const cap = capture();
  const code = await withCapturedStdout(cap.writer, () => runHelpCli({ topic: "not-a-topic" }));
  assert.equal(code, 1);
  assert.match(cap.chunks.join(""), /Unknown help topic/u);
});
