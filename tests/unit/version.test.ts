import assert from "node:assert/strict";
import test from "node:test";

import { withCapturedStdout } from "../../src/host/io.js";
import { formatVersionPlain, printVersion } from "../../src/host/commands/version.js";
import {
  BAKUDO_VERSION,
  PROTOCOL_VERSION,
  SESSION_SCHEMA_VERSION,
  buildVersionEnvelope,
} from "../../src/version.js";

type Capture = {
  writer: { write: (chunk: string) => boolean };
  chunks: string[];
};

const capture = (): Capture => {
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

test("buildVersionEnvelope: returns stable shape with name, version, protocolVersion, sessionSchemaVersion", () => {
  const envelope = buildVersionEnvelope();
  assert.equal(envelope.name, "bakudo");
  assert.equal(typeof envelope.version, "string");
  assert.equal(envelope.protocolVersion, PROTOCOL_VERSION);
  assert.equal(envelope.sessionSchemaVersion, SESSION_SCHEMA_VERSION);
});

test("BAKUDO_VERSION resolves to the package.json version (semver-ish string)", () => {
  assert.match(BAKUDO_VERSION, /^\d+\.\d+\.\d+/u);
});

test("formatVersionPlain: single-line 'bakudo <version>'", () => {
  assert.equal(formatVersionPlain("0.42.0"), "bakudo 0.42.0");
});

test("formatVersionPlain uses BAKUDO_VERSION by default", () => {
  assert.equal(formatVersionPlain(), `bakudo ${BAKUDO_VERSION}`);
});

test("printVersion (plain): emits 'bakudo <version>\\n' to stdout", async () => {
  const cap = capture();
  await withCapturedStdout(cap.writer, async () => {
    printVersion({});
  });
  assert.equal(cap.chunks.length, 1);
  const line = cap.chunks[0]!;
  assert.ok(line.endsWith("\n"), "expected trailing newline");
  assert.equal(line.trim(), `bakudo ${BAKUDO_VERSION}`);
});

test("printVersion (json): emits a single JSON line with the full envelope", async () => {
  const cap = capture();
  await withCapturedStdout(cap.writer, async () => {
    printVersion({ useJson: true });
  });
  assert.equal(cap.chunks.length, 1);
  const parsed = JSON.parse(cap.chunks[0]!.trim()) as {
    name: string;
    version: string;
    protocolVersion: number;
    sessionSchemaVersion: number;
  };
  assert.equal(parsed.name, "bakudo");
  assert.equal(parsed.version, BAKUDO_VERSION);
  assert.equal(parsed.protocolVersion, PROTOCOL_VERSION);
  assert.equal(parsed.sessionSchemaVersion, SESSION_SCHEMA_VERSION);
});

test("printVersion returns the envelope even when writing plain output", async () => {
  const cap = capture();
  let returned: ReturnType<typeof printVersion> | undefined;
  await withCapturedStdout(cap.writer, async () => {
    returned = printVersion({});
  });
  assert.ok(returned);
  assert.equal(returned.name, "bakudo");
});
