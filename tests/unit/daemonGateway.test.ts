/**
 * Wave 3: Daemon Gateway & Objective State unit tests.
 *
 * Tests the Objective state model, ResourceBudget, ObjectiveController, and
 * the Daemon Gateway HTTP endpoints using a mock ABoxTaskRunner.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { Mutex } from "async-mutex";
import {
  createObjective,
  createCampaign,
  ObjectiveSchema,
  CampaignSchema,
} from "../../src/host/orchestration/objectiveState.js";
import { defaultBudget } from "../../src/host/orchestration/resourceBudget.js";
import { ObjectiveController } from "../../src/host/orchestration/objectiveController.js";
import { createGateway } from "../../src/daemon/gateway.js";
import type { ABoxTaskRunner, TaskExecutionRecord } from "../../src/aboxTaskRunner.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeRecord = (stdout: string, ok = true): TaskExecutionRecord => ({
  events: [],
  ok,
  rawOutput: stdout,
  workerErrors: [],
  result: {
    schemaVersion: 1 as const,
    taskId: "task-1",
    sessionId: "session-1",
    status: ok ? "succeeded" : "failed",
    summary: ok ? "done" : "failed",
    exitCode: ok ? 0 : 1,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: 100,
    exitSignal: null,
    stdout,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    assumeDangerousSkipPermissions: false,
    command: "claude --print-responses",
    cwd: "/workspace",
    shell: "/bin/sh",
    timeoutSeconds: 120,
  },
});

const mockMutex = new Mutex();

// ---------------------------------------------------------------------------
// Objective state model
// ---------------------------------------------------------------------------

test("objectiveState: createObjective produces valid Objective", () => {
  const obj = createObjective("obj-1", "Refactor auth middleware");
  const parsed = ObjectiveSchema.parse(obj);
  assert.equal(parsed.objectiveId, "obj-1");
  assert.equal(parsed.goal, "Refactor auth middleware");
  assert.equal(parsed.status, "active");
  assert.deepEqual(parsed.campaigns, []);
  assert.ok(parsed.createdAt !== undefined);
});

test("objectiveState: createCampaign produces valid Campaign", () => {
  const campaign = createCampaign("write-jwt", "Implement JWT utility", { candidates: [] });
  const parsed = CampaignSchema.parse(campaign);
  assert.equal(parsed.campaignId, "write-jwt");
  assert.equal(parsed.description, "Implement JWT utility");
  assert.equal(parsed.status, "pending");
  assert.equal(parsed.winnerCandidateId, undefined);
});

// ---------------------------------------------------------------------------
// ResourceBudget
// ---------------------------------------------------------------------------

test("resourceBudget: defaultBudget has expected values", () => {
  assert.equal(defaultBudget.maxConcurrentSandboxes, 5);
  assert.equal(defaultBudget.maxCandidatesPerCampaign, 3);
  assert.ok(defaultBudget.perRoleLimits["worker"] !== undefined);
  assert.ok(defaultBudget.perRoleLimits["chaos-monkey"] !== undefined);
  assert.ok(defaultBudget.perRoleLimits["architect"] !== undefined);
});

test("resourceBudget: worker role has higher memory than chaos-monkey", () => {
  const worker = defaultBudget.perRoleLimits["worker"];
  const monkey = defaultBudget.perRoleLimits["chaos-monkey"];
  assert.ok(worker !== undefined && monkey !== undefined);
  assert.ok(worker.memoryMb > monkey.memoryMb);
});

// ---------------------------------------------------------------------------
// ObjectiveController
// ---------------------------------------------------------------------------

test("objectiveController: advance() is no-op for completed objective", async () => {
  const obj = createObjective("obj-1", "test");
  obj.status = "completed";
  let callCount = 0;
  const mockRunner = {
    runAttempt: async () => { callCount++; return makeRecord("LGTM"); },
  } as unknown as ABoxTaskRunner;

  const controller = new ObjectiveController(obj, mockRunner, mockMutex);
  await controller.advance();
  assert.equal(callCount, 0, "advance() should not call runner for completed objective");
});

test("objectiveController: advance() is no-op for paused objective", async () => {
  const obj = createObjective("obj-1", "test");
  obj.status = "paused";
  let callCount = 0;
  const mockRunner = {
    runAttempt: async () => { callCount++; return makeRecord("LGTM"); },
  } as unknown as ABoxTaskRunner;

  const controller = new ObjectiveController(obj, mockRunner, mockMutex);
  await controller.advance();
  assert.equal(callCount, 0, "advance() should not call runner for paused objective");
});

test("objectiveController: advance() marks objective failed when architect returns no JSON", async () => {
  const obj = createObjective("obj-1", "test");
  const mockRunner = {
    runAttempt: async () => makeRecord("I cannot decompose this goal."),
  } as unknown as ABoxTaskRunner;

  const controller = new ObjectiveController(obj, mockRunner, mockMutex);
  await controller.advance();
  assert.equal(controller.state.status, "failed");
  assert.equal(controller.state.campaigns.length, 0);
});

test("objectiveController: advance() populates campaigns from architect JSON", async () => {
  const obj = createObjective("obj-1", "Refactor auth");
  const architectOutput = JSON.stringify([
    { campaignId: "write-jwt", description: "Implement JWT utility" },
    { campaignId: "update-middleware", description: "Update auth middleware" },
  ]);
  let callCount = 0;
  const mockRunner = {
    // Wave 5: runAttempt receives (spec, overrides, handlers, profile).
    // Explorer is called first (profile.providerId === 'explorer'), then Architect.
    runAttempt: async (
      _spec: unknown,
      _overrides: unknown,
      _handlers: unknown,
      profile?: { providerId?: string },
    ) => {
      callCount++;
      if (profile?.providerId === "explorer") {
        // Explorer: return invalid report so Architect still runs
        return makeRecord("not a valid intelligence report");
      }
      return makeRecord(architectOutput);
    },
  } as unknown as ABoxTaskRunner;

  const controller = new ObjectiveController(obj, mockRunner, mockMutex);
  await controller.advance();

  // Wave 5: Explorer (call 1) + Architect (call 2); campaigns were populated
  assert.ok(callCount >= 1, `Expected at least 1 call, got ${callCount}`);
  assert.equal(controller.state.campaigns.length, 2);
  assert.equal(controller.state.campaigns[0]?.campaignId, "write-jwt");
  assert.equal(controller.state.campaigns[1]?.campaignId, "update-middleware");
  assert.equal(controller.state.campaigns[0]?.status, "pending");
});

test("objectiveController: advance() executes campaign candidates after decomposition", async () => {
  const obj = createObjective("obj-1", "Refactor auth");
  const architectOutput = JSON.stringify([
    { campaignId: "write-jwt", description: "Implement JWT utility" },
  ]);

  // Pre-populate a candidate so the campaign has something to execute
  let callCount = 0;
  const mockRunner = {
    // Wave 5: runAttempt receives (spec, overrides, handlers, profile).
    runAttempt: async (
      _spec: unknown,
      _overrides: unknown,
      _handlers: unknown,
      profile?: { providerId?: string },
    ) => {
      callCount++;
      if (profile?.providerId === "explorer") {
        // Explorer: return invalid report so Architect still runs
        return makeRecord("not a valid intelligence report");
      }
      if (profile?.providerId === "architect") {
        return makeRecord(architectOutput);
      }
      if (profile?.providerId === "chaos-monkey") {
        return makeRecord("LGTM");
      }
      // Worker: succeed
      return makeRecord("implementation done");
    },
  } as unknown as ABoxTaskRunner;

  const controller = new ObjectiveController(obj, mockRunner, mockMutex);

  // First advance: decompose
  await controller.advance();
  assert.equal(controller.state.campaigns.length, 1);

  // Inject a candidate into the campaign so advance() has something to run
  const campaign = controller.state.campaigns[0] as typeof controller.state.campaigns[0] & {
    candidateSet: { candidates: unknown[] };
  };
  campaign.candidateSet.candidates = [
    {
      schemaVersion: 1,
      candidateId: "cand-1",
      profile: { providerId: "codex", sandboxLifecycle: "preserved", candidatePolicy: "discard" },
      spec: {
        schemaVersion: 3,
        sessionId: "s1",
        turnId: "t1",
        attemptId: "a1",
        taskId: "tk1",
        intentId: "i1",
        mode: "build",
        taskKind: "assistant_job",
        prompt: "implement",
        instructions: [],
        cwd: "/tmp",
        execution: { engine: "agent_cli" },
        permissions: { rules: [], allowAllTools: false, noAskUser: false },
        budget: { timeoutSeconds: 60, maxOutputBytes: 131072, heartbeatIntervalMs: 5000 },
        acceptanceChecks: [],
        artifactRequests: [],
      },
    },
  ];

  // Second advance: execute the campaign
  await controller.advance();
  assert.equal(controller.state.campaigns[0]?.status, "completed");
  assert.equal(controller.state.campaigns[0]?.winnerCandidateId, "cand-1");
});

test("objectiveController: marks campaign failed when all candidates fail", async () => {
  const obj = createObjective("obj-1", "Refactor auth");
  const architectOutput = JSON.stringify([
    { campaignId: "write-jwt", description: "Implement JWT utility" },
  ]);

  let callCount = 0;
  const mockRunner = {
    // Wave 5: runAttempt receives (spec, overrides, handlers, profile).
    runAttempt: async (
      _spec: unknown,
      _overrides: unknown,
      _handlers: unknown,
      profile?: { providerId?: string },
    ) => {
      callCount++;
      if (profile?.providerId === "explorer") {
        return makeRecord("not a valid intelligence report");
      }
      if (profile?.providerId === "architect") {
        return makeRecord(architectOutput);
      }
      // Worker always fails; Critic also fails (non-fatal)
      return makeRecord("compilation error", false);
    },
  } as unknown as ABoxTaskRunner;

  const controller = new ObjectiveController(obj, mockRunner, mockMutex);
  await controller.advance();

  // Inject a candidate
  const campaign = controller.state.campaigns[0] as typeof controller.state.campaigns[0] & {
    candidateSet: { candidates: unknown[] };
  };
  campaign.candidateSet.candidates = [
    {
      schemaVersion: 1,
      candidateId: "cand-1",
      profile: { providerId: "codex", sandboxLifecycle: "preserved", candidatePolicy: "discard" },
      spec: {
        schemaVersion: 3,
        sessionId: "s1",
        turnId: "t1",
        attemptId: "a1",
        taskId: "tk1",
        intentId: "i1",
        mode: "build",
        taskKind: "assistant_job",
        prompt: "implement",
        instructions: [],
        cwd: "/tmp",
        execution: { engine: "agent_cli" },
        permissions: { rules: [], allowAllTools: false, noAskUser: false },
        budget: { timeoutSeconds: 60, maxOutputBytes: 131072, heartbeatIntervalMs: 5000 },
        acceptanceChecks: [],
        artifactRequests: [],
      },
    },
  ];

  await controller.advance();
  assert.equal(controller.state.campaigns[0]?.status, "failed");
});

// ---------------------------------------------------------------------------
// CandidateSet schema: objectiveId and campaignId fields
// ---------------------------------------------------------------------------

test("attemptProtocol: CandidateSet schema accepts objectiveId and campaignId", async () => {
  const { CandidateSetSchema } = await import("../../src/attemptProtocol.js");
  const candidateSet = {
    batchId: "batch-1",
    intentId: "intent-1",
    candidates: [],
    objectiveId: "obj-1",
    campaignId: "campaign-1",
  };
  const parsed = CandidateSetSchema.parse(candidateSet);
  assert.equal(parsed.objectiveId, "obj-1");
  assert.equal(parsed.campaignId, "campaign-1");
});

test("attemptProtocol: CandidateSet schema accepts missing objectiveId and campaignId", async () => {
  const { CandidateSetSchema } = await import("../../src/attemptProtocol.js");
  const candidateSet = {
    batchId: "batch-1",
    intentId: "intent-1",
    candidates: [],
  };
  const parsed = CandidateSetSchema.parse(candidateSet);
  assert.equal(parsed.objectiveId, undefined);
  assert.equal(parsed.campaignId, undefined);
});

// ---------------------------------------------------------------------------
// Daemon Gateway HTTP endpoints
// ---------------------------------------------------------------------------

test("daemonGateway: POST /objective returns 400 for missing goal", async () => {
  const mockRunner = {
    runAttempt: async () => makeRecord("LGTM"),
  } as unknown as ABoxTaskRunner;

  const app = createGateway(mockRunner);
  // Use a simple HTTP request simulation via supertest-like approach
  // Since we don't have supertest, we'll test the route handler logic directly
  // by calling the express app with a mock request/response.
  let statusCode = 0;
  let responseBody: unknown = null;

  const mockReq = { body: {} } as Parameters<Parameters<typeof app.post>[1]>[0];
  const mockRes = {
    status(code: number) { statusCode = code; return this; },
    json(body: unknown) { responseBody = body; return this; },
  } as unknown as Parameters<Parameters<typeof app.post>[1]>[1];

  // Access the route handler directly
  // Since we can't easily do this with Express 5, we'll test the gateway
  // by starting a server and making a real HTTP request.
  const { createServer } = await import("node:http");
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/objective`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 400);
    const body = await response.json() as { error: string };
    assert.ok(body.error.includes("goal"), "error message should mention 'goal'");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("daemonGateway: POST /objective returns 202 with objectiveId for valid goal", async () => {
  const mockRunner = {
    runAttempt: async () => makeRecord("[]"), // Architect returns empty array
  } as unknown as ABoxTaskRunner;

  const app = createGateway(mockRunner);
  const { createServer } = await import("node:http");
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/objective`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "Refactor auth middleware to use JWT" }),
    });
    assert.equal(response.status, 202);
    const body = await response.json() as { objectiveId: string; status: string };
    assert.ok(body.objectiveId.startsWith("obj-"), "objectiveId should start with 'obj-'");
    assert.equal(body.status, "accepted");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("daemonGateway: GET /objective/:id returns 404 for unknown id", async () => {
  const mockRunner = {
    runAttempt: async () => makeRecord("LGTM"),
  } as unknown as ABoxTaskRunner;

  const app = createGateway(mockRunner);
  const { createServer } = await import("node:http");
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/objective/unknown-id`);
    assert.equal(response.status, 404);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("daemonGateway: GET /objectives returns list of objectives", async () => {
  const mockRunner = {
    runAttempt: async () => makeRecord("[]"),
  } as unknown as ABoxTaskRunner;

  const app = createGateway(mockRunner);
  const { createServer } = await import("node:http");
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };

  try {
    // Submit an objective first
    await fetch(`http://127.0.0.1:${address.port}/objective`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "Test objective" }),
    });

    const response = await fetch(`http://127.0.0.1:${address.port}/objectives`);
    assert.equal(response.status, 200);
    const body = await response.json() as { objectives: unknown[] };
    assert.ok(Array.isArray(body.objectives));
    assert.ok(body.objectives.length >= 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
