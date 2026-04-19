import assert from "node:assert/strict";
import test from "node:test";

import { probeWorkerCapabilities } from "../../src/host/workerCapabilities.js";

const aboxBin = process.env.BAKUDO_INTEGRATION_ABOX_BIN;

if (aboxBin === undefined || aboxBin.trim() === "") {
  test.skip("F-00 acceptance: probeWorkerCapabilities returns source === 'probe' against live abox", () => {});
} else {
  test("F-00 acceptance: probeWorkerCapabilities returns source === 'probe' against live abox", async () => {
    const outcome = await probeWorkerCapabilities({ bin: aboxBin });

    assert.equal(
      outcome.capabilities.source,
      "probe",
      `expected source to be 'probe' (probe succeeded); got '${outcome.capabilities.source}' with fallbackReason='${outcome.fallbackReason ?? "n/a"}'`,
    );
    assert.deepEqual(outcome.capabilities.protocolVersions, [1, 3]);
    assert.deepEqual(outcome.capabilities.taskKinds, [
      "assistant_job",
      "explicit_command",
      "verification_check",
    ]);
    assert.deepEqual(outcome.capabilities.executionEngines, ["agent_cli", "shell"]);
  });
}
