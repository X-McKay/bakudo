import assert from "node:assert/strict";
import test from "node:test";

import {
  artifactNamesForResolutionPath,
  buildApplyResolvePrompt,
  classifyConflictResolutionEligibility,
  parseApplyResolveResult,
} from "../../src/host/conflictResolution.js";

test("classifyConflictResolutionEligibility: bounded text overlaps are eligible", () => {
  const eligibility = classifyConflictResolutionEligibility({
    path: "src/app.ts",
    conflict: {
      path: "src/app.ts",
      class: "textual_overlap",
      decision: "needs_confirmation",
      reason: "textual overlap requires confirmation for src/app.ts",
      detail: "both_modified_different",
    },
    baseContent: "const value = 1;\n",
    candidateContent: "const value = 2;\n",
    sourceContent: "const value = 3;\n",
  });

  assert.deepEqual(eligibility, {
    eligible: true,
    reason: "src/app.ts is a bounded text overlap eligible for apply_resolve",
  });
});

test("classifyConflictResolutionEligibility: generated and lockfile-like surfaces stay confirmation-only", () => {
  const generated = classifyConflictResolutionEligibility({
    path: "dist/app.min.js",
    conflict: {
      path: "dist/app.min.js",
      class: "textual_overlap",
      decision: "needs_confirmation",
      reason: "textual overlap requires confirmation for dist/app.min.js",
      detail: "both_modified_different",
    },
    baseContent: "a();\n",
    candidateContent: "b();\n",
    sourceContent: "c();\n",
  });

  assert.equal(generated.eligible, false);
  assert.match(generated.reason, /generated or minified/u);
});

test("buildApplyResolvePrompt and parseApplyResolveResult keep the path contract explicit", () => {
  const prompt = buildApplyResolvePrompt({
    originalSpec: {
      schemaVersion: 3,
      sessionId: "session-1",
      turnId: "turn-1",
      attemptId: "attempt-1",
      taskId: "attempt-1",
      intentId: "intent-1",
      mode: "build",
      taskKind: "assistant_job",
      prompt: "reconcile the candidate change without dropping the current source behavior",
      instructions: ["Preserve the user-visible behavior."],
      cwd: "/repo",
      execution: { engine: "agent_cli" },
      permissions: { rules: [], allowAllTools: false, noAskUser: false },
      budget: { timeoutSeconds: 60, maxOutputBytes: 1024, heartbeatIntervalMs: 1000 },
      acceptanceChecks: [],
      artifactRequests: [],
    },
    conflict: {
      path: "README.md",
      conflict: {
        path: "README.md",
        class: "textual_overlap",
        decision: "needs_confirmation",
        reason: "textual overlap requires confirmation for README.md",
        detail: "both_modified_different",
      },
      baseContent: "hello\n",
      candidateContent: "hello\ncandidate\n",
      sourceContent: "hello\nsource\n",
    },
  });

  assert.match(prompt.prompt, /README\.md/u);
  assert.match(prompt.instructions.join("\n"), /\$BAKUDO_GUEST_OUTPUT_DIR\/result\.json/u);

  const parsed = parseApplyResolveResult(
    JSON.stringify({
      path: "README.md",
      resolvedContent: "hello\nsource and candidate\n",
      rationale: "kept both lines",
      confidence: "high",
    }),
    "README.md",
  );
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.value.confidence, "high");
    assert.equal(parsed.value.resolvedContent, "hello\nsource and candidate\n");
  }

  const artifactNames = artifactNamesForResolutionPath("README.md");
  assert.match(artifactNames.dispatch, /^apply-resolve-readme-md-/u);
  assert.match(artifactNames.result, /-result\.json$/u);
});
