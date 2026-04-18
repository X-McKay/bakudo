import assert from "node:assert/strict";
import test from "node:test";

import type { SessionEventEnvelope } from "../../src/protocol.js";
import type { SessionRecord } from "../../src/sessionTypes.js";
import { formatUsageOutput, runUsage } from "../../src/host/commands/usage.js";
import {
  buildUsageSessionRow,
  extractTokenTotals,
  formatUsageReport,
  parseUsageArgs,
  sumUsageTotals,
  tokensFromEnvelope,
} from "../../src/host/commands/usageSupport.js";

// ---------------------------------------------------------------------------
// parseUsageArgs
// ---------------------------------------------------------------------------

test("parseUsageArgs: --session <id>", () => {
  const r = parseUsageArgs(["--session", "session-42"]);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.args.sessionId, "session-42");
});

test("parseUsageArgs: --since 7d", () => {
  const r = parseUsageArgs(["--since", "7d"]);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.args.sinceMs, 7 * 86_400_000);
});

test("parseUsageArgs: --format text|json", () => {
  const text = parseUsageArgs(["--format", "text"]);
  const json = parseUsageArgs(["--format=json"]);
  assert.equal(text.ok && text.args.format, "text");
  assert.equal(json.ok && json.args.format, "json");
});

test("parseUsageArgs: --format rejects unknown values", () => {
  const r = parseUsageArgs(["--format", "xml"]);
  assert.equal(r.ok, false);
});

test("parseUsageArgs: unknown flag → structured error", () => {
  const r = parseUsageArgs(["--rogue"]);
  assert.equal(r.ok, false);
});

// ---------------------------------------------------------------------------
// Token extraction
// ---------------------------------------------------------------------------

test("extractTokenTotals: accepts camelCase keys", () => {
  const t = extractTokenTotals({ promptTokens: 12, completionTokens: 34 });
  assert.equal(t.prompt, 12);
  assert.equal(t.completion, 34);
  assert.equal(t.total, 46);
});

test("extractTokenTotals: accepts snake_case keys (OpenAI-style)", () => {
  const t = extractTokenTotals({ prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 });
  assert.equal(t.total, 30);
});

test("extractTokenTotals: non-object input yields zeros", () => {
  const t = extractTokenTotals("not-an-object");
  assert.deepEqual(t, { prompt: 0, completion: 0, total: 0 });
});

test("tokensFromEnvelope: prefers payload.tokens over payload.usage", () => {
  const envelope: SessionEventEnvelope = {
    schemaVersion: 2,
    eventId: "e1",
    sessionId: "s",
    actor: "worker",
    kind: "worker.attempt_completed",
    timestamp: "2026-04-18T00:00:00.000Z",
    payload: {
      tokens: { prompt: 100, completion: 200 },
      usage: { prompt: 1, completion: 2 },
    },
  };
  const t = tokensFromEnvelope(envelope);
  assert.equal(t.prompt, 100);
  assert.equal(t.completion, 200);
});

test("tokensFromEnvelope: falls back to payload.usage when tokens is absent", () => {
  const envelope: SessionEventEnvelope = {
    schemaVersion: 2,
    eventId: "e1",
    sessionId: "s",
    actor: "worker",
    kind: "worker.attempt_completed",
    timestamp: "2026-04-18T00:00:00.000Z",
    payload: { usage: { prompt_tokens: 5, completion_tokens: 6 } },
  };
  const t = tokensFromEnvelope(envelope);
  assert.equal(t.total, 11);
});

// ---------------------------------------------------------------------------
// buildUsageSessionRow
// ---------------------------------------------------------------------------

const session = (sessionId: string, overrides: Partial<SessionRecord> = {}): SessionRecord => ({
  schemaVersion: 2,
  sessionId,
  repoRoot: "/tmp/repo",
  title: overrides.title ?? "fixture",
  status: overrides.status ?? "completed",
  turns:
    overrides.turns ??
    ([
      {
        turnId: "turn-1",
        prompt: "p",
        mode: "build",
        status: "completed",
        attempts: [
          { attemptId: "a-1", status: "succeeded", metadata: { agentProfile: "default" } },
          { attemptId: "a-2", status: "succeeded", metadata: {} },
        ],
        createdAt: "2026-04-18T00:00:00.000Z",
        updatedAt: "2026-04-18T00:01:00.000Z",
      },
    ] as SessionRecord["turns"]),
  createdAt: "2026-04-18T00:00:00.000Z",
  updatedAt: overrides.updatedAt ?? "2026-04-18T00:01:00.000Z",
});

test("buildUsageSessionRow: counts turns + attempts and sums token envelopes", () => {
  const envelopes: SessionEventEnvelope[] = [
    {
      schemaVersion: 2,
      eventId: "e1",
      sessionId: "s",
      actor: "worker",
      kind: "worker.attempt_completed",
      timestamp: "2026-04-18T00:00:30.000Z",
      payload: { tokens: { prompt: 100, completion: 50 } },
    },
    {
      schemaVersion: 2,
      eventId: "e2",
      sessionId: "s",
      actor: "worker",
      kind: "worker.attempt_completed",
      timestamp: "2026-04-18T00:00:45.000Z",
      payload: { tokens: { prompt: 10, completion: 5 } },
    },
  ];
  const row = buildUsageSessionRow({ session: session("s"), envelopes });
  assert.equal(row.turns, 1);
  assert.equal(row.attempts, 2);
  assert.equal(row.tokens.prompt, 110);
  assert.equal(row.tokens.completion, 55);
  assert.equal(row.tokens.total, 165);
  assert.deepEqual(row.agentProfiles, ["default"]);
});

test("buildUsageSessionRow: cutoffIso drops older envelopes from token totals", () => {
  const envelopes: SessionEventEnvelope[] = [
    {
      schemaVersion: 2,
      eventId: "e-old",
      sessionId: "s",
      actor: "worker",
      kind: "worker.attempt_completed",
      timestamp: "2026-04-17T00:00:00.000Z",
      payload: { tokens: { prompt: 999, completion: 999 } },
    },
    {
      schemaVersion: 2,
      eventId: "e-new",
      sessionId: "s",
      actor: "worker",
      kind: "worker.attempt_completed",
      timestamp: "2026-04-18T00:00:00.000Z",
      payload: { tokens: { prompt: 1, completion: 1 } },
    },
  ];
  const row = buildUsageSessionRow({
    session: session("s"),
    envelopes,
    cutoffIso: "2026-04-18T00:00:00.000Z",
  });
  assert.equal(row.tokens.prompt, 1);
});

test("buildUsageSessionRow: falls back to attempt metadata tokens when no envelope totals", () => {
  const s = session("s", {
    turns: [
      {
        turnId: "turn-1",
        prompt: "p",
        mode: "build",
        status: "completed",
        attempts: [{ attemptId: "a-1", status: "succeeded", metadata: { tokens: { total: 42 } } }],
        createdAt: "2026-04-18T00:00:00.000Z",
        updatedAt: "2026-04-18T00:01:00.000Z",
      },
    ] as SessionRecord["turns"],
  });
  const row = buildUsageSessionRow({ session: s, envelopes: [] });
  assert.equal(row.tokens.total, 42);
});

// ---------------------------------------------------------------------------
// formatUsageReport + runUsage
// ---------------------------------------------------------------------------

test("formatUsageReport: empty report still shows header", () => {
  const lines = formatUsageReport({ args: {}, sessions: [], totals: sumUsageTotals([]) });
  assert.match(lines[0] ?? "", /bakudo usage/);
  assert.match(lines.join("\n"), /no sessions match/);
});

test("formatUsageReport: renders a table with totals", () => {
  const row = buildUsageSessionRow({
    session: session("session-x"),
    envelopes: [
      {
        schemaVersion: 2,
        eventId: "e",
        sessionId: "session-x",
        actor: "worker",
        kind: "worker.attempt_completed",
        timestamp: "2026-04-18T00:00:05.000Z",
        payload: { tokens: { prompt: 1, completion: 2 } },
      },
    ],
  });
  const body = formatUsageReport({
    args: {},
    sessions: [row],
    totals: sumUsageTotals([row]),
  }).join("\n");
  assert.match(body, /session-x/);
  assert.match(body, /totals: prompt=1/);
});

test("formatUsageOutput: json mode serialises the full report", () => {
  const report = { args: {}, sessions: [], totals: { prompt: 0, completion: 0, total: 0 } };
  const out = formatUsageOutput(report, "json");
  const parsed = JSON.parse(out);
  assert.deepEqual(parsed.totals, { prompt: 0, completion: 0, total: 0 });
});

test("runUsage: nonexistent storage root yields an empty report without throwing", async () => {
  const report = await runUsage({ args: {}, storageRoot: "/tmp/nonexistent-usage-root" });
  assert.deepEqual(report.sessions, []);
  assert.deepEqual(report.totals, { prompt: 0, completion: 0, total: 0 });
});
