import test from "node:test";
import assert from "node:assert";
import { AgentHarness, defaultHarnessConfig } from "../../src/orchestrator.js";
import { Mode, RiskLevel } from "../../src/models.js";
import { MemoryStore } from "../../src/memory.js";

// Mock ToolRuntime
const mockRuntime = {
  spec: (name: string) => ({ name, description: name, risk: RiskLevel.Read }),
  execute: async () => ({ ok: true, output: "mock output" }),
};

// Mock PolicyEngine
const mockPolicy = {
  evaluate: () => ({ decision: "allow", reason: "mock allow" }),
};

test("AgentHarness: initializes and can plan steps", async () => {
  const config = defaultHarnessConfig();
  config.mode = Mode.Plan;

  const harness = new AgentHarness(mockRuntime as any, mockPolicy as any, config);
  const memory = await harness.executeGoal("test goal", ["s1"]);

  assert.ok(memory instanceof MemoryStore);
  assert.strictEqual(memory.state.goal, "test goal");

  // Verify traces are logged via streamNotes (2 steps planned per stream)
  const notes = memory.state.streamNotes["s1"];
  if (!notes) {
    throw new Error("Notes should be defined for stream s1");
  }
  assert.strictEqual(notes.length, 2);
  assert.match(notes[0]!, /tool=git_status/);
  assert.match(notes[1]!, /tool=shell/);
});

test("AgentHarness: respects maxTotalSteps budget", async () => {
  const config = defaultHarnessConfig();
  config.budget.maxTotalSteps = 1;

  const harness = new AgentHarness(mockRuntime as any, mockPolicy as any, config);
  const memory = await harness.executeGoal("test goal", ["s1"]);

  // Should have 2 notes, but the second one should indicate budget exceeded
  const notes = memory.state.streamNotes["s1"];
  if (!notes) {
    throw new Error("Notes should be defined for stream s1");
  }
  assert.strictEqual(notes.length, 2);
  assert.match(notes[1]!, /detail=autonomy budget exceeded/);
});
