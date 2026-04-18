import test from "node:test";
import assert from "node:assert/strict";

import {
  BAKUDO_PROTOCOL_SCHEMA_VERSION,
  createTaskSessionKey,
  isTerminalTaskStatus,
  isTaskProgressEventKind,
  taskProgressEventKinds,
  terminalTaskStatuses,
} from "../../src/protocol.js";
import {
  createSessionTaskKey,
  isTerminalSessionStatus,
  sessionTerminalStatuses,
} from "../../src/sessionTypes.js";

test("protocol scaffolding exposes the expected schema and helper shapes", () => {
  assert.equal(BAKUDO_PROTOCOL_SCHEMA_VERSION, 1);
  assert.deepEqual(terminalTaskStatuses, [
    "succeeded",
    "failed",
    "blocked",
    "cancelled",
    "needs_review",
  ]);
  assert.deepEqual(taskProgressEventKinds, [
    "task.queued",
    "task.started",
    "task.progress",
    "task.checkpoint",
    "task.completed",
    "task.failed",
  ]);
});

test("protocol helpers classify terminal statuses and event kinds", () => {
  assert.equal(isTerminalTaskStatus("running"), false);
  assert.equal(isTerminalTaskStatus("succeeded"), true);
  assert.equal(isTaskProgressEventKind("task.progress"), true);
  assert.equal(isTaskProgressEventKind("task.unknown"), false);
});

test("session helpers stay aligned with the shared scaffold", () => {
  assert.deepEqual(sessionTerminalStatuses, ["completed", "blocked", "failed", "cancelled"]);
  assert.equal(isTerminalSessionStatus("reviewing"), false);
  assert.equal(isTerminalSessionStatus("completed"), true);
  assert.equal(createTaskSessionKey("session-1", "task-1"), "session-1:task-1");
  assert.equal(createSessionTaskKey("session-1", "task-1"), "1:session-1:task-1");
});
