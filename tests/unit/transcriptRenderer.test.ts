import test from "node:test";
import assert from "node:assert/strict";

import { stripAnsi } from "../../src/host/ansi.js";
import { initialHostAppState } from "../../src/host/appState.js";
import { reduceHost } from "../../src/host/reducer.js";
import {
  selectRenderFrame,
  type RenderFrame,
  type TranscriptItem,
} from "../../src/host/renderModel.js";
import { renderTranscriptFrame } from "../../src/host/renderers/transcriptRenderer.js";
import { renderTranscriptFramePlain } from "../../src/host/renderers/plainRenderer.js";

const baseTranscript: TranscriptItem[] = [
  { kind: "user", text: "do the thing" },
  { kind: "assistant", text: "working on it", tone: "info" },
  { kind: "event", label: "dispatch", detail: "task-1" },
  { kind: "output", text: "line one\nline two" },
  { kind: "review", outcome: "success", summary: "all green", nextAction: "review" },
];

const buildFrame = (overrides: Partial<RenderFrame> = {}): RenderFrame => {
  const state = initialHostAppState();
  const frame = selectRenderFrame({
    state,
    transcript: baseTranscript,
    repoLabel: "/tmp/repo",
  });
  return { ...frame, ...overrides };
};

const renderers: Array<[string, (frame: RenderFrame) => string[]]> = [
  ["transcript", renderTranscriptFrame],
  ["plain", renderTranscriptFramePlain],
];

for (const [label, render] of renderers) {
  test(`${label} renderer: header line includes Bakudo and mode chip`, () => {
    const lines = render(buildFrame()).map(stripAnsi);
    assert.ok(lines[0]?.includes("Bakudo"), `expected Bakudo in: ${lines[0]}`);
    assert.ok(lines[0]?.includes("STANDARD"), `expected STANDARD in: ${lines[0]}`);
  });

  test(`${label} renderer: each transcript item kind renders identifying text`, () => {
    const lines = render(buildFrame()).map(stripAnsi);
    const joined = lines.join("\n");
    assert.ok(joined.includes("You: do the thing"));
    assert.ok(joined.includes("Bakudo: working on it"));
    assert.ok(joined.includes("dispatch"));
    assert.ok(joined.includes("task-1"));
    assert.ok(joined.includes("  line one"));
    assert.ok(joined.includes("  line two"));
    assert.ok(joined.includes("Review: success"));
    assert.ok(joined.includes("all green"));
    assert.ok(joined.includes("next: review"));
  });

  test(`${label} renderer: output items render as an indented block`, () => {
    const lines = render(buildFrame()).map(stripAnsi);
    assert.ok(lines.includes("  line one"));
    assert.ok(lines.includes("  line two"));
    assert.ok(!lines.includes("Bakudo: line one"));
    assert.ok(!lines.includes("· output line one"));
  });

  test(`${label} renderer: prompt "> " appears only when mode is prompt`, () => {
    const promptLines = render(buildFrame({ mode: "prompt" })).map(stripAnsi);
    assert.ok(promptLines.some((line) => line === "> "));
    const transcriptLines = render(buildFrame({ mode: "transcript" })).map(stripAnsi);
    assert.ok(!transcriptLines.some((line) => line === "> "));
  });

  test(`${label} renderer: footer hints appear as a joined line`, () => {
    const lines = render(buildFrame()).map(stripAnsi);
    assert.ok(lines.some((line) => line.includes("[help]")));
  });
}

test("transcript renderer: header mirrors plan mode when composer is plan", () => {
  const state = reduceHost(initialHostAppState(), { type: "set_mode", mode: "plan" });
  const frame = selectRenderFrame({ state, transcript: [] });
  const lines = renderTranscriptFrame(frame).map(stripAnsi);
  assert.ok(lines[0]?.includes("PLAN"));
});
