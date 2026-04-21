/**
 * Wave 1: Provider Registry unit tests.
 *
 * Tests the ProviderRegistry class, the default registrations, and the
 * integration with assistantJobRunner (resolvedCommand from host-resolved profile).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { providerRegistry, type ProviderSpec } from "../../src/host/providerRegistry.js";
import { runAssistantJob } from "../../src/worker/assistantJobRunner.js";
import type { AttemptSpec } from "../../src/attemptProtocol.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const baseSpec = (overrides: Partial<AttemptSpec> = {}): AttemptSpec => ({
  schemaVersion: 3,
  sessionId: "session-1",
  turnId: "turn-1",
  attemptId: "attempt-1",
  taskId: "task-1",
  intentId: "intent-1",
  mode: "build",
  taskKind: "assistant_job",
  prompt: "implement the feature",
  instructions: [],
  cwd: "/tmp",
  execution: { engine: "agent_cli" },
  permissions: { rules: [], allowAllTools: false, noAskUser: false },
  budget: { timeoutSeconds: 120, maxOutputBytes: 262144, heartbeatIntervalMs: 5000 },
  acceptanceChecks: [],
  artifactRequests: [],
  ...overrides,
});

// ---------------------------------------------------------------------------
// Registry: default registrations
// ---------------------------------------------------------------------------

test("providerRegistry: has claude-code registered by default", () => {
  const spec = providerRegistry.get("claude-code");
  assert.equal(spec.id, "claude-code");
  assert.ok(spec.command.length > 0, "command should be non-empty");
  assert.ok(spec.requiredPolicies.includes("anthropic-api"), "should require anthropic-api policy");
});

test("providerRegistry: has codex registered by default", () => {
  const spec = providerRegistry.get("codex");
  assert.equal(spec.id, "codex");
  assert.equal(spec.command[0], "codex");
  assert.ok(spec.requiredPolicies.includes("openai-api"), "should require openai-api policy");
});

test("providerRegistry: has opendevin registered by default", () => {
  const spec = providerRegistry.get("opendevin");
  assert.equal(spec.id, "opendevin");
  assert.ok(spec.requiredPolicies.includes("openai-api"), "should require openai-api policy");
  assert.ok(spec.requiredPolicies.includes("github-api"), "should require github-api policy");
});

test("providerRegistry: list() returns all registered providers", () => {
  const all = providerRegistry.list();
  const ids = all.map((p) => p.id);
  assert.ok(ids.includes("claude-code"), "should include claude-code");
  assert.ok(ids.includes("codex"), "should include codex");
  assert.ok(ids.includes("opendevin"), "should include opendevin");
});

// ---------------------------------------------------------------------------
// Registry: error handling
// ---------------------------------------------------------------------------

test("providerRegistry: throws descriptive error for unknown provider", () => {
  assert.throws(
    () => providerRegistry.get("nonexistent-provider-xyz"),
    (err: Error) => {
      assert.ok(err.message.includes("nonexistent-provider-xyz"), "error should mention the ID");
      assert.ok(err.message.includes("Known providers"), "error should list known providers");
      return true;
    },
  );
});

test("providerRegistry: has() returns false for unknown provider", () => {
  assert.equal(providerRegistry.has("nonexistent-xyz"), false);
});

test("providerRegistry: has() returns true for registered provider", () => {
  assert.equal(providerRegistry.has("codex"), true);
});

// ---------------------------------------------------------------------------
// Registry: custom registration
// ---------------------------------------------------------------------------

test("providerRegistry: register() adds a new provider", () => {
  const testSpec: ProviderSpec = {
    id: "test-local-llm-wave1",
    name: "Test Local LLM",
    command: ["ollama", "run", "llama3"],
    requiredPolicies: [],
  };
  providerRegistry.register(testSpec);
  const retrieved = providerRegistry.get("test-local-llm-wave1");
  assert.equal(retrieved.id, "test-local-llm-wave1");
  assert.deepEqual(retrieved.command, ["ollama", "run", "llama3"]);
  assert.deepEqual(retrieved.requiredPolicies, []);
});

test("providerRegistry: register() overwrites existing provider", () => {
  const updated: ProviderSpec = {
    id: "test-local-llm-wave1",
    name: "Updated Local LLM",
    command: ["ollama", "run", "llama3.1"],
    requiredPolicies: ["local-inference"],
  };
  providerRegistry.register(updated);
  const retrieved = providerRegistry.get("test-local-llm-wave1");
  assert.equal(retrieved.name, "Updated Local LLM");
  assert.deepEqual(retrieved.command, ["ollama", "run", "llama3.1"]);
});

// ---------------------------------------------------------------------------
// assistantJobRunner: uses resolvedCommand from host-resolved profile
// ---------------------------------------------------------------------------

test("assistantJobRunner: uses resolvedCommand from profile (codex)", () => {
  const spec = baseSpec();
  const profile = {
    providerId: "codex",
    resolvedCommand: ["codex", "exec", "--dangerously-bypass-approvals-and-sandbox"],
    sandboxLifecycle: "ephemeral" as const,
    candidatePolicy: "discard" as const,
  };
  const result = runAssistantJob(spec, profile);
  assert.equal(result.command[0], "codex");
  assert.ok(result.stdin?.includes("implement the feature"), "prompt should be in stdin");
});

test("assistantJobRunner: uses resolvedCommand from profile (claude-code)", () => {
  const spec = baseSpec({ prompt: "write tests" });
  const profile = {
    providerId: "claude-code",
    resolvedCommand: ["claude", "--dangerously-skip-permissions"],
    sandboxLifecycle: "ephemeral" as const,
    candidatePolicy: "discard" as const,
  };
  const result = runAssistantJob(spec, profile);
  assert.equal(result.command[0], "claude");
  assert.ok(result.stdin?.includes("write tests"), "prompt should be in stdin");
});

test("assistantJobRunner: throws when resolvedCommand is empty", () => {
  const spec = baseSpec();
  const profile = {
    providerId: "codex",
    resolvedCommand: [] as string[],
    sandboxLifecycle: "ephemeral" as const,
    candidatePolicy: "discard" as const,
  };
  assert.throws(
    () => runAssistantJob(spec, profile),
    (err: Error) => {
      assert.ok(err.message.includes("resolvedCommand is empty"), "error should mention resolvedCommand");
      return true;
    },
  );
});

test("assistantJobRunner: joins prompt and instructions with double newlines", () => {
  const spec = baseSpec({
    prompt: "do the thing",
    instructions: ["rule one", "rule two"],
  });
  const profile = {
    providerId: "codex",
    resolvedCommand: ["codex", "exec", "--dangerously-bypass-approvals-and-sandbox"],
    sandboxLifecycle: "ephemeral" as const,
    candidatePolicy: "discard" as const,
  };
  const result = runAssistantJob(spec, profile);
  assert.equal(result.stdin, "do the thing\n\nrule one\n\nrule two");
});

test("assistantJobRunner: sets BAKUDO_GUEST_OUTPUT_DIR env", () => {
  const spec = baseSpec({ attemptId: "attempt-42" });
  const profile = {
    providerId: "codex",
    resolvedCommand: ["codex", "exec", "--dangerously-bypass-approvals-and-sandbox"],
    sandboxLifecycle: "ephemeral" as const,
    candidatePolicy: "discard" as const,
  };
  const result = runAssistantJob(spec, profile);
  assert.ok(
    result.env?.BAKUDO_GUEST_OUTPUT_DIR?.includes("attempt-42"),
    "BAKUDO_GUEST_OUTPUT_DIR should reference the attempt ID",
  );
});

// ---------------------------------------------------------------------------
// Local LLM test: mock provider pointing to a local script
// ---------------------------------------------------------------------------

test("providerRegistry: local LLM mock provider resolves correctly", () => {
  // Register a mock provider pointing to a local llama.cpp CLI script.
  // This simulates the Wave 1 acceptance criterion: use any LLM backend
  // via the registry without hardcoding.
  const localLlmSpec: ProviderSpec = {
    id: "local-llama-cpp",
    name: "Local llama.cpp",
    command: ["/usr/local/bin/llama-cli", "--model", "/models/llama3.gguf", "--headless"],
    requiredPolicies: [], // local inference — no abox proxy needed
  };
  providerRegistry.register(localLlmSpec);

  const spec = baseSpec({ prompt: "local LLM test prompt" });
  const profile = {
    providerId: "local-llama-cpp",
    resolvedCommand: localLlmSpec.command,
    sandboxLifecycle: "ephemeral" as const,
    candidatePolicy: "discard" as const,
  };
  const result = runAssistantJob(spec, profile);
  assert.equal(result.command[0], "/usr/local/bin/llama-cli");
  assert.deepEqual(result.command, [
    "/usr/local/bin/llama-cli",
    "--model",
    "/models/llama3.gguf",
    "--headless",
  ]);
  assert.ok(result.stdin?.includes("local LLM test prompt"), "prompt should be in stdin");
});
