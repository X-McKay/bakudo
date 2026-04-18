/**
 * Wave 6c PR7 / A6.1 — local-only OpenTelemetry span instrumentation.
 *
 * Plan lines 854-870. Covers:
 *
 *   - Per-turn root span + per-attempt child span shape.
 *   - Hook events as span events, not child spans (line 866).
 *   - Custom attribute keys (bakudo.time_to_first_event_ms,
 *     bakudo.dropped_event_batches, bakudo.policy_decision_count).
 *   - OTLP-JSON payload wrapper shape for on-disk + future OTLP export.
 *   - `describeOtlpEndpoint`: `OTEL_EXPORTER_OTLP_ENDPOINT` surfaces host
 *     but never bearer tokens.
 *   - Rotation: spans-on-disk kept to 10.
 */

import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildOtlpPayload,
  countSpanFilesOnDisk,
  describeOtlpEndpoint,
  rotateSpanFiles,
  SPAN_FILES_KEEP,
  SpanRecorder,
  startSpan,
  toOtlpSpan,
} from "../../src/host/telemetry/otelSpans.js";

test("startSpan: emits ids, records attributes, events, and a close-time delta", () => {
  let t = 100;
  const clock = (): number => {
    const v = t;
    t += 7;
    return v;
  };
  const span = startSpan({
    name: "bakudo.turn",
    attributes: {
      "bakudo.session.id": "sess-1",
      "bakudo.turn.id": "turn-1",
      "bakudo.agent_profile": "default",
    },
    clock,
  });
  span.setAttr("bakudo.policy_decision_count", 2);
  span.addEvent({ name: "hook.preToolUse", timestampMs: 105 });
  const finished = span.end("ok");
  assert.ok(/^[0-9a-f]{32}$/.test(finished.traceId));
  assert.ok(/^[0-9a-f]{16}$/.test(finished.spanId));
  assert.equal(finished.name, "bakudo.turn");
  assert.equal(finished.attributes["bakudo.session.id"], "sess-1");
  assert.equal(finished.attributes["bakudo.policy_decision_count"], 2);
  assert.equal(finished.events.length, 1);
  assert.equal(finished.events[0]?.name, "hook.preToolUse");
  assert.ok(finished.endTimeMs > finished.startTimeMs);
  assert.equal(finished.status, "ok");
});

test("startSpan: child spans track parentSpanId (per-attempt under per-turn)", () => {
  const turn = startSpan({ name: "bakudo.turn", clock: () => 1 });
  const attempt = startSpan({
    name: "bakudo.attempt",
    traceId: turn.traceId,
    parentSpanId: turn.spanId,
    attributes: {
      "bakudo.attempt.id": "a-1",
      "bakudo.task_kind": "plan",
      "bakudo.sandbox_task_id": "s-1",
      "bakudo.exit_code": 0,
    },
    clock: () => 2,
  });
  const finished = attempt.end();
  assert.equal(finished.traceId, turn.traceId);
  assert.equal(finished.parentSpanId, turn.spanId);
});

test("startSpan: hook events are span events, not child spans (plan line 866)", () => {
  const span = startSpan({ name: "bakudo.turn", clock: () => 0 });
  span.addEvent({ name: "hook.sessionStart", timestampMs: 1 });
  span.addEvent({ name: "hook.postToolUse", timestampMs: 2 });
  const finished = span.end();
  // Finished span has exactly two events; none of them are child spans.
  assert.equal(finished.events.length, 2);
  assert.equal(finished.events[0]!.name, "hook.sessionStart");
  assert.equal(finished.events[1]!.name, "hook.postToolUse");
});

test("toOtlpSpan: converts span to OTLP-JSON wire shape", () => {
  const span = startSpan({
    name: "bakudo.turn",
    attributes: {
      "bakudo.time_to_first_event_ms": 23,
      "bakudo.dropped_event_batches": 0,
      "bakudo.policy_decision_count": 1,
    },
    clock: () => 1_000,
  });
  const wire = toOtlpSpan(span.end());
  const attrKeys = wire.attributes.map((a) => a.key);
  assert.ok(attrKeys.includes("bakudo.time_to_first_event_ms"));
  assert.ok(attrKeys.includes("bakudo.dropped_event_batches"));
  assert.ok(attrKeys.includes("bakudo.policy_decision_count"));
  assert.match(wire.startTimeUnixNano, /^[0-9]+$/);
  assert.match(wire.endTimeUnixNano, /^[0-9]+$/);
  assert.equal(wire.status.code, 1);
});

test("buildOtlpPayload: envelope shape matches resourceSpans → scopeSpans → spans", () => {
  const span = startSpan({ name: "bakudo.turn", clock: () => 0 }).end();
  const payload = buildOtlpPayload([span]);
  assert.equal(payload.resourceSpans.length, 1);
  const rs = payload.resourceSpans[0]!;
  assert.equal(rs.resource.attributes[0]!.key, "service.name");
  assert.equal(rs.scopeSpans[0]!.scope.name, "bakudo");
  assert.equal(rs.scopeSpans[0]!.spans.length, 1);
});

test("describeOtlpEndpoint: unset env → {configured:false}", () => {
  assert.deepEqual(describeOtlpEndpoint({}), { configured: false });
  assert.deepEqual(describeOtlpEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: "" }), {
    configured: false,
  });
});

test("describeOtlpEndpoint: valid URL surfaces only the host (never bearer token)", () => {
  const desc = describeOtlpEndpoint({
    OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.example.com:4318/v1/traces",
    OTEL_EXPORTER_OTLP_HEADERS: "authorization=Bearer topsecret",
  });
  assert.equal(desc.configured, true);
  assert.equal(desc.host, "otel.example.com:4318");
  // The bearer token is not surfaced anywhere in the returned record.
  assert.equal(JSON.stringify(desc).includes("topsecret"), false);
  assert.equal(JSON.stringify(desc).includes("Bearer"), false);
});

test("describeOtlpEndpoint: malformed URL still reports configured but with a sanitised host", () => {
  const desc = describeOtlpEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: "not a url" });
  assert.equal(desc.configured, true);
  assert.equal(desc.host, "<invalid-url>");
});

test("SpanRecorder: flush writes a spans-{iso}.json file and clears buffer", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bakudo-spans-"));
  try {
    const rec = new SpanRecorder();
    rec.record(startSpan({ name: "bakudo.turn", clock: () => 0 }).end());
    rec.record(startSpan({ name: "bakudo.attempt", clock: () => 1 }).end());
    const path = await rec.flush({ logDir: dir });
    assert.ok(path !== null);
    assert.equal(rec.size(), 0);
    const body = await readFile(path!, "utf8");
    const payload = JSON.parse(body) as { resourceSpans: unknown[] };
    assert.equal(payload.resourceSpans.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SpanRecorder: empty flush returns null without creating a file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bakudo-spans-"));
  try {
    const rec = new SpanRecorder();
    const path = await rec.flush({ logDir: dir });
    assert.equal(path, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rotateSpanFiles: keeps only 10 newest span files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bakudo-spans-"));
  try {
    for (let i = 0; i < 12; i += 1) {
      await writeFile(
        join(dir, `spans-2026-04-15T12-00-${String(i).padStart(2, "0")}-000Z.json`),
        "{}",
        "utf8",
      );
      await new Promise((res) => setTimeout(res, 6));
    }
    const removed = await rotateSpanFiles(dir, 10);
    assert.equal(removed.length, 2);
    const remaining = await readdir(dir);
    assert.equal(remaining.length, 10);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("countSpanFilesOnDisk: counts only spans-*.json in the given dir", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bakudo-spans-"));
  try {
    await writeFile(join(dir, "spans-a.json"), "{}", "utf8");
    await writeFile(join(dir, "spans-b.json"), "{}", "utf8");
    await writeFile(join(dir, "bakudo-x.log"), "", "utf8");
    assert.equal(await countSpanFilesOnDisk(dir), 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SPAN_FILES_KEEP is 10 per plan A6.1 L1", () => {
  assert.equal(SPAN_FILES_KEEP, 10);
});
