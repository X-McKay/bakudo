import assert from "node:assert/strict";
import test from "node:test";

import {
  KNOWN_HELP_TOPICS,
  helpTopicFileName,
  isKnownHelpTopic,
  listAvailableHelpTopics,
  loadHelpTopic,
  unknownTopicMessage,
} from "../../src/host/helpTopicLoader.js";

test("KNOWN_HELP_TOPICS contains the candidate/apply help surface plus the Phase-5 topics", () => {
  for (const expected of [
    "candidate-apply",
    "config",
    "hooks",
    "permissions",
    "monitoring",
    "sandbox",
  ]) {
    assert.ok(
      KNOWN_HELP_TOPICS.includes(expected as (typeof KNOWN_HELP_TOPICS)[number]),
      `missing topic: ${expected}`,
    );
  }
});

test("isKnownHelpTopic accepts shipped topics and rejects unknown", () => {
  assert.equal(isKnownHelpTopic("config"), true);
  assert.equal(isKnownHelpTopic("wat"), false);
});

test("helpTopicFileName: topic → '<topic>.md'", () => {
  assert.equal(helpTopicFileName("config"), "config.md");
});

test("loadHelpTopic('config'): reads a non-empty markdown body", async () => {
  const loaded = await loadHelpTopic("config");
  assert.ok(loaded, "expected config topic to be found");
  assert.ok(loaded.content.length > 0);
  assert.match(loaded.content, /bakudo config/u);
  assert.ok(loaded.path.endsWith("config.md"));
});

test("loadHelpTopic returns null for unknown topics", async () => {
  const loaded = await loadHelpTopic("nonexistent");
  assert.equal(loaded, null);
});

test("loadHelpTopic('hooks') includes event-name documentation", async () => {
  const loaded = await loadHelpTopic("hooks");
  assert.ok(loaded);
  assert.match(loaded.content, /host\.approval_requested/u);
});

test("loadHelpTopic('candidate-apply') documents apply_verify and apply_resolve", async () => {
  const loaded = await loadHelpTopic("candidate-apply");
  assert.ok(loaded);
  assert.match(loaded.content, /apply_verify/u);
  assert.match(loaded.content, /apply_resolve/u);
});

test("loadHelpTopic('permissions') covers the deny-precedence invariant", async () => {
  const loaded = await loadHelpTopic("permissions");
  assert.ok(loaded);
  assert.match(loaded.content, /deny-precedence/iu);
});

test("loadHelpTopic('sandbox') describes the --ephemeral semantics", async () => {
  const loaded = await loadHelpTopic("sandbox");
  assert.ok(loaded);
  assert.match(loaded.content, /--ephemeral/u);
});

test("loadHelpTopic('monitoring') mentions bakudo doctor", async () => {
  const loaded = await loadHelpTopic("monitoring");
  assert.ok(loaded);
  assert.match(loaded.content, /bakudo doctor/u);
});

test("listAvailableHelpTopics returns a sorted superset of KNOWN_HELP_TOPICS", async () => {
  const topics = await listAvailableHelpTopics();
  for (const expected of KNOWN_HELP_TOPICS) {
    assert.ok(topics.includes(expected), `missing: ${expected}`);
  }
  const sorted = [...topics].sort();
  assert.deepEqual(topics, sorted, "topics should be sorted");
});

test("unknownTopicMessage lists the known topics", () => {
  const msg = unknownTopicMessage("foo");
  assert.match(msg, /Unknown help topic: "foo"/u);
  for (const topic of KNOWN_HELP_TOPICS) {
    assert.ok(msg.includes(topic), `expected topic name ${topic} in message`);
  }
});
