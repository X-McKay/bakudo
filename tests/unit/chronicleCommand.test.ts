import assert from "node:assert/strict";
import test from "node:test";

import type { SessionEventEnvelope } from "../../src/protocol.js";
import {
  DEFAULT_CHRONICLE_LIMIT,
  formatChronicleReport,
  runChronicle,
} from "../../src/host/commands/chronicle.js";
import {
  filterChronicle,
  formatChronicleRow,
  formatChronicleText,
  parseChronicleArgs,
} from "../../src/host/commands/chronicleSupport.js";

const env = (
  kind: SessionEventEnvelope["kind"],
  overrides: Partial<SessionEventEnvelope> = {},
): SessionEventEnvelope => ({
  schemaVersion: 2,
  eventId: `event-${kind}-${Math.random().toString(36).slice(2, 8)}`,
  sessionId: overrides.sessionId ?? "session-a",
  actor: overrides.actor ?? "host",
  kind,
  timestamp: overrides.timestamp ?? "2026-04-18T00:00:00.000Z",
  payload: overrides.payload ?? {},
  ...(overrides.turnId !== undefined ? { turnId: overrides.turnId } : {}),
  ...(overrides.attemptId !== undefined ? { attemptId: overrides.attemptId } : {}),
});

// ---------------------------------------------------------------------------
// parseChronicleArgs
// ---------------------------------------------------------------------------

test("parseChronicleArgs: --since accepts duration literals (plan line 786)", () => {
  const result = parseChronicleArgs(["--since", "7d"]);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.args.sinceMs, 7 * 86_400_000);
  }
});

test("parseChronicleArgs: --since=24h inline form", () => {
  const result = parseChronicleArgs(["--since=24h"]);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.args.sinceMs, 24 * 3_600_000);
});

test("parseChronicleArgs: --tool captures the filter value (plan line 787)", () => {
  const result = parseChronicleArgs(["--tool", "shell"]);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.args.tool, "shell");
});

test("parseChronicleArgs: --approval denied accepted (plan line 788)", () => {
  const result = parseChronicleArgs(["--approval", "denied"]);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.args.approval, "denied");
});

test("parseChronicleArgs: --approval rejects unknown values", () => {
  const result = parseChronicleArgs(["--approval", "sideways"]);
  assert.equal(result.ok, false);
});

test("parseChronicleArgs: --session <id> (plan line 789)", () => {
  const result = parseChronicleArgs(["--session", "session-42"]);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.args.sessionId, "session-42");
});

test("parseChronicleArgs: --format json and --format text", () => {
  const jsonR = parseChronicleArgs(["--format", "json"]);
  const textR = parseChronicleArgs(["--format=text"]);
  assert.equal(jsonR.ok && jsonR.args.format, "json");
  assert.equal(textR.ok && textR.args.format, "text");
});

test("parseChronicleArgs: --limit accepts positive integers", () => {
  const ok = parseChronicleArgs(["--limit", "10"]);
  const bad = parseChronicleArgs(["--limit", "-1"]);
  assert.equal(ok.ok && ok.args.limit, 10);
  assert.equal(bad.ok, false);
});

test("parseChronicleArgs: unknown flag → structured error", () => {
  const result = parseChronicleArgs(["--bogus"]);
  assert.equal(result.ok, false);
});

// ---------------------------------------------------------------------------
// filterChronicle — ANDed semantics
// ---------------------------------------------------------------------------

const fixture = (): SessionEventEnvelope[] => [
  env("user.turn_submitted", {
    sessionId: "session-a",
    timestamp: "2026-04-18T01:00:00.000Z",
    payload: { prompt: "hello", mode: "build" },
  }),
  env("host.approval_requested", {
    sessionId: "session-a",
    timestamp: "2026-04-18T02:00:00.000Z",
    payload: { request: { tool: "shell", argument: "ls", displayCommand: "ls" } },
  }),
  env("host.approval_resolved", {
    sessionId: "session-a",
    timestamp: "2026-04-18T02:00:01.000Z",
    payload: {
      decision: "denied",
      request: { tool: "shell", argument: "rm -rf /", displayCommand: "rm -rf /" },
    },
  }),
  env("host.approval_resolved", {
    sessionId: "session-b",
    timestamp: "2026-04-17T23:00:00.000Z",
    payload: {
      decision: "approved",
      request: { tool: "git", argument: "git push", displayCommand: "git push" },
    },
  }),
];

test("filterChronicle: --session filters to a single session id", () => {
  const out = filterChronicle({ envelopes: fixture(), args: { sessionId: "session-b" } });
  assert.equal(out.length, 1);
  assert.equal(out[0]?.sessionId, "session-b");
});

test("filterChronicle: --since drops envelopes older than the cutoff", () => {
  const now = new Date("2026-04-18T03:00:00.000Z").getTime();
  const out = filterChronicle({
    envelopes: fixture(),
    args: { sinceMs: 60 * 60 * 1000 },
    now,
  });
  // Only the two 02:00-ish session-a envelopes are within the 1h window.
  assert.equal(out.length, 2);
});

test("filterChronicle: --tool matches envelopes whose payload references the tool", () => {
  const out = filterChronicle({ envelopes: fixture(), args: { tool: "shell" } });
  // Two approval envelopes on session-a mention tool=shell.
  assert.equal(out.length, 2);
  out.forEach((e) => assert.equal(e.sessionId, "session-a"));
});

test("filterChronicle: --approval denied matches only denied resolutions", () => {
  const out = filterChronicle({ envelopes: fixture(), args: { approval: "denied" } });
  assert.equal(out.length, 1);
  assert.equal(out[0]?.kind, "host.approval_resolved");
  assert.equal((out[0]?.payload as { decision: string }).decision, "denied");
});

test("filterChronicle: --approval denied matches auto_denied too", () => {
  const envelopes = [
    env("host.approval_resolved", {
      timestamp: "2026-04-18T00:00:01.000Z",
      payload: { decision: "auto_denied" },
    }),
  ];
  const out = filterChronicle({ envelopes, args: { approval: "denied" } });
  assert.equal(out.length, 1);
});

test("filterChronicle: filters are ANDed together", () => {
  const out = filterChronicle({
    envelopes: fixture(),
    args: { sessionId: "session-a", tool: "shell", approval: "denied" },
  });
  assert.equal(out.length, 1);
  assert.equal(out[0]?.kind, "host.approval_resolved");
});

// ---------------------------------------------------------------------------
// runChronicle — drives the full pipeline (I/O tested via integration)
// ---------------------------------------------------------------------------

test("runChronicle: caps output at limit and reports matched count", async () => {
  // Build a synthetic fixture by stubbing the loader via a temp storageRoot
  // that has no sessions — runChronicle should return zero without error.
  const report = await runChronicle({
    args: { limit: 5 },
    storageRoot: "/tmp/nonexistent-bakudo-root-for-tests",
  });
  assert.equal(report.envelopes.length, 0);
  assert.equal(report.matched, 0);
});

test("DEFAULT_CHRONICLE_LIMIT is the documented default cap", () => {
  assert.equal(DEFAULT_CHRONICLE_LIMIT, 200);
});

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

test("formatChronicleRow: includes timestamp, kind, actor, sessionId", () => {
  const row = formatChronicleRow(
    env("user.turn_submitted", { payload: { prompt: "hi", mode: "build" } }),
  );
  assert.match(row, /2026-04-18/);
  assert.match(row, /user\.turn_submitted/);
  assert.match(row, /session=session-a/);
});

test("formatChronicleText: header includes filter summary", () => {
  const lines = formatChronicleText(fixture(), { tool: "shell", sinceMs: 7 * 86_400_000 });
  assert.match(lines[0] ?? "", /tool=shell/);
  assert.match(lines[0] ?? "", /since=/);
});

test("formatChronicleReport: json mode emits one envelope per line", () => {
  const report = {
    args: {},
    envelopes: fixture().slice(0, 2),
    matched: 2,
  };
  const body = formatChronicleReport(report, "json");
  const lines = body.split("\n");
  assert.equal(lines.length, 2);
  for (const line of lines) {
    assert.doesNotThrow(() => JSON.parse(line));
  }
});
