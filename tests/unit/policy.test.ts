import test from "node:test";
import assert from "node:assert";
import { PolicyEngine, type PolicyConfig } from "../../src/policy.js";
import { Mode, RiskLevel, Decision, type ToolSpec } from "../../src/models.js";

const createBaseConfig = (): PolicyConfig => ({
  mode: Mode.Build,
  allowedTools: new Set(["shell", "git_status"]),
  writeTools: new Set(["shell_write"]),
  networkTools: new Set(["curl"]),
  destructiveTools: new Set(["rm"]),
  assumeDangerousSkipPermissions: false,
  requireEscalationForWrite: true,
  requireEscalationForNetwork: true,
});

test("PolicyEngine: denies tools not in allowed list", () => {
  const config = createBaseConfig();
  const engine = new PolicyEngine(config);

  const unknownTool: ToolSpec = {
    name: "unknown",
    description: "unknown tool",
    risk: RiskLevel.Read,
  };
  const decision = engine.evaluate(unknownTool);

  assert.strictEqual(decision.decision, Decision.Deny);
  assert.match(decision.reason, /is not allowed in mode=build/);
});

test("PolicyEngine: denies destructive tools without permit", () => {
  const config = createBaseConfig();
  config.allowedTools.add("rm");
  config.destructiveTools = new Set<string>(); // Remove permit
  const engine = new PolicyEngine(config);

  const destructiveTool: ToolSpec = {
    name: "rm",
    description: "remove file",
    risk: RiskLevel.Destructive,
    destructive: true,
  };
  const decision = engine.evaluate(destructiveTool);

  assert.strictEqual(decision.decision, Decision.Deny);
  assert.match(decision.reason, /has no destructive permit/);
});

test("PolicyEngine: escalates write tools when required", () => {
  const config = createBaseConfig();
  config.allowedTools.add("shell_write");
  const engine = new PolicyEngine(config);

  const writeTool: ToolSpec = {
    name: "shell_write",
    description: "write to shell",
    risk: RiskLevel.Write,
    requiresWrite: true,
  };
  const decision = engine.evaluate(writeTool);

  assert.strictEqual(decision.decision, Decision.Escalate);
  assert.match(decision.reason, /write action requires escalation/);
});

test("PolicyEngine: allows everything in dangerous-skip-permissions mode", () => {
  const config = createBaseConfig();
  config.assumeDangerousSkipPermissions = true;
  config.allowedTools.add("shell_write");
  const engine = new PolicyEngine(config);

  const writeTool: ToolSpec = {
    name: "shell_write",
    description: "write to shell",
    risk: RiskLevel.Write,
    requiresWrite: true,
  };
  const decision = engine.evaluate(writeTool);

  assert.strictEqual(decision.decision, Decision.Allow);
  assert.match(decision.reason, /dangerous-skip-permissions profile enabled/);
});
