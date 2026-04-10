import test from "node:test";
import assert from "node:assert";
import { AgentHarness, defaultHarnessConfig } from "../../src/orchestrator.js";
import { RiskLevel } from "../../src/models.js";

// Mock ToolRuntime
const mockRuntime = {
  spec: (name: string) => ({ name, description: name, risk: RiskLevel.Read }),
  execute: async () => ({ ok: true, output: "mock output" }),
};

// Mock PolicyEngine
const mockPolicy = {
  evaluate: () => ({ decision: "allow", reason: "mock allow" }),
};

test("Regression Bug #001: AgentHarness should handle empty streams gracefully", async () => {
  const config = defaultHarnessConfig();
  const harness = new AgentHarness(mockRuntime as any, mockPolicy as any, config);
  
  // Executing with empty streams should result in no notes
  const memory = await harness.executeGoal("test goal", []);

  assert.strictEqual(Object.keys(memory.state.streamNotes).length, 0);
  assert.strictEqual(memory.state.goal, "test goal");
});
