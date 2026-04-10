import test from "node:test";
import assert from "node:assert";
import { AgentHarness, defaultHarnessConfig } from "../../src/orchestrator.js";
import { Mode, Decision } from "../../src/models.js";
import { PolicyEngine, type PolicyConfig } from "../../src/policy.js";
import { ToolRuntime } from "../../src/tools.js";

test("Integration: end-to-end planning to execution workflow", async () => {
  const config = defaultHarnessConfig();
  config.mode = Mode.Build;
  config.assumeDangerousSkipPermissions = true;
  config.budget.maxTotalSteps = 10;

  const policyConfig: PolicyConfig = {
    mode: Mode.Build,
    allowedTools: new Set(["git_status", "shell_write"]),
    writeTools: new Set(["shell_write"]),
    networkTools: new Set<string>(),
    destructiveTools: new Set<string>(),
    assumeDangerousSkipPermissions: true,
    requireEscalationForWrite: false,
    requireEscalationForNetwork: false,
  };

  const policy = new PolicyEngine(policyConfig);
  // We need to mock the adapter since ToolRuntime requires it
  const mockAdapter = {
    runInStream: async () => ({ ok: true, output: "mock output" })
  };
  const runtime = new ToolRuntime(mockAdapter as any);
  const harness = new AgentHarness(runtime, policy, config);

  // Execute a goal
  const memory = await harness.executeGoal("echo 'hello'", ["s1"]);

  // Verify memory and notes
  assert.strictEqual(memory.state.goal, "echo 'hello'");
  const notes = memory.state.streamNotes["s1"];
  if (!notes) {
    throw new Error("Notes should be defined for stream s1");
  }
  assert.strictEqual(notes.length, 2);
  
  // First step should be git_status
  assert.match(notes[0]!, /tool=git_status/);
  assert.match(notes[0]!, new RegExp(`decision=${Decision.Allow}`));
  
  // Second step should be shell_write
  assert.match(notes[1]!, /tool=shell_write/);
  assert.match(notes[1]!, new RegExp(`decision=${Decision.Allow}`));
});
