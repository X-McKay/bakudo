import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { stripAnsi } from "../../src/host/ansi.js";
import { initialHostAppState, type ApprovalPromptRequest } from "../../src/host/appState.js";
import { reduceHost } from "../../src/host/reducer.js";
import { selectRenderFrame } from "../../src/host/renderModel.js";
import { renderTranscriptFrame } from "../../src/host/renderers/transcriptRenderer.js";
import { renderTranscriptFramePlain } from "../../src/host/renderers/plainRenderer.js";

/**
 * Phase 4 PR7 — verbatim approval-prompt copy assertions.
 *
 * These tests enforce the exact strings mandated by plan
 * `04-provenance-first-inspection-and-approval.md` §"Approval Prompt UX"
 * and `phase-4-record-design.md` §3.4. Byte-for-byte matching — the
 * product surface contract.
 */

const enqueueApprovalPrompt = (request: ApprovalPromptRequest) =>
  reduceHost(initialHostAppState(), {
    type: "enqueue_prompt",
    prompt: { id: "p-approval-1", kind: "approval_prompt", payload: request },
  });

const renderLines = (request: ApprovalPromptRequest, mode: "transcript" | "plain"): string[] => {
  const state = enqueueApprovalPrompt(request);
  const frame = selectRenderFrame({ state, transcript: [] });
  const render = mode === "transcript" ? renderTranscriptFrame : renderTranscriptFramePlain;
  return render(frame).map(stripAnsi);
};

const expectVerbatim = (lines: string[], displayCommand: string, allowAlways: string): void => {
  const idx = lines.findIndex((line) => line === `Bakudo: Worker wants to run: ${displayCommand}`);
  assert.ok(idx >= 0, `missing line 1: ${JSON.stringify(lines)}`);
  assert.equal(lines[idx + 1], "Bakudo: This matches no existing allow rule in agent=standard.");
  assert.equal(lines[idx + 2], "");
  assert.equal(lines[idx + 3], "  \u276F [1] allow once");
  assert.equal(lines[idx + 4], `    [2] allow always for ${allowAlways}`);
  assert.equal(lines[idx + 5], "    [3] deny");
  assert.equal(lines[idx + 6], "    [4] show context (inspect attempt spec)");
  assert.equal(lines[idx + 7], "");
  assert.equal(lines[idx + 8], "Choice [1/2/3/4] (Shift+Tab to go back):");
};

const shellRequest = (argument: string): ApprovalPromptRequest => ({
  sessionId: "s",
  turnId: "t",
  attemptId: "a",
  tool: "shell",
  argument,
  policySnapshot: { agent: "standard", composerMode: "standard", autopilot: false },
});

test("approval prompt copy: shell git push renders verbatim (transcript)", () => {
  const lines = renderLines(shellRequest("git push origin main"), "transcript");
  expectVerbatim(lines, "shell(git push origin main)", "shell(git push:*)");
});

test("approval prompt copy: shell git push renders verbatim (plain)", () => {
  const lines = renderLines(shellRequest("git push origin main"), "plain");
  expectVerbatim(lines, "shell(git push origin main)", "shell(git push:*)");
});

test("approval prompt copy: write tool produces directory-scoped pattern", () => {
  const req: ApprovalPromptRequest = {
    ...shellRequest("src/foo/bar.ts"),
    tool: "write",
  };
  const lines = renderLines(req, "plain");
  expectVerbatim(lines, "write(src/foo/bar.ts)", "write(src/foo/*)");
});

test("approval prompt copy: network tool produces host-wildcard pattern", () => {
  const req: ApprovalPromptRequest = {
    ...shellRequest("https://api.github.com/repos/x/y"),
    tool: "network",
  };
  const lines = renderLines(req, "plain");
  expectVerbatim(
    lines,
    "network(https://api.github.com/repos/x/y)",
    "network(https://api.github.com/**)",
  );
});

test("approval prompt copy: unknown tool falls back to wildcard pattern", () => {
  const req: ApprovalPromptRequest = {
    ...shellRequest("some-arg"),
    tool: "custom-tool",
  };
  const lines = renderLines(req, "plain");
  expectVerbatim(lines, "custom-tool(some-arg)", "custom-tool(*)");
});

test("approval prompt copy: empty shell argument falls back to wildcard", () => {
  const req = shellRequest("");
  const lines = renderLines(req, "plain");
  expectVerbatim(lines, "shell()", "shell(*)");
});

test("approval prompt copy: autopilot flag is NOT rendered in the overlay (intentional)", () => {
  const req: ApprovalPromptRequest = {
    ...shellRequest("ls"),
    policySnapshot: { agent: "standard", composerMode: "autopilot", autopilot: true },
  };
  const lines = renderLines(req, "plain");
  const joined = lines.join("\n");
  assert.ok(!joined.toLowerCase().includes("autopilot"), "autopilot must not appear in overlay");
  assert.ok(!joined.includes("true"), "autopilot=true must not leak into overlay copy");
});

test("approval prompt copy: agent name flows from policy snapshot", () => {
  const req: ApprovalPromptRequest = {
    ...shellRequest("ls"),
    policySnapshot: { agent: "custom-profile", composerMode: "standard", autopilot: false },
  };
  const lines = renderLines(req, "plain");
  const agentLine = lines.find((line) =>
    line.startsWith("Bakudo: This matches no existing allow rule in agent="),
  );
  assert.ok(agentLine !== undefined);
  assert.equal(agentLine, "Bakudo: This matches no existing allow rule in agent=custom-profile.");
});

test("approval prompt copy: cursor pins to [1] (Shift+Tab deferred to Phase 5)", () => {
  const lines = renderLines(shellRequest("ls"), "plain");
  const cursorLine = lines.find((line) => line.includes("\u276F"));
  assert.ok(cursorLine !== undefined);
  assert.equal(cursorLine, "  \u276F [1] allow once");
});

test("approval prompt copy: approvalPromptCopy module carries the Phase 5 TODO comment", async () => {
  // Smoke check that the deferral is documented as requested by the PR
  // scope. Keeps future contributors from silently dropping the note.
  // Look up the source via several candidate roots so the test works both
  // when invoked from `dist/` (pnpm test) and directly against `src/`.
  // Resolve the source via `import.meta.url` so this works whether the test
  // file is loaded from `src/` (direct invocation) or `dist/` (pnpm test).
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "../../src/host/renderers/approvalPromptCopy.ts"),
    join(here, "../../../src/host/renderers/approvalPromptCopy.ts"),
  ];
  let source = "";
  for (const path of candidates) {
    const text = await readFile(path, "utf8").catch(() => "");
    if (text.length > 0) {
      source = text;
      break;
    }
  }
  assert.ok(source.length > 0, `approvalPromptCopy.ts source not found from ${here}`);
  assert.ok(/TODO\(phase5\)/.test(source), "expected TODO(phase5) marker in approvalPromptCopy.ts");
});
