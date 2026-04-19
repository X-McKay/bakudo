import assert from "node:assert/strict";
import test from "node:test";

import {
  LEGACY_SYSTEM_VIRTIOFSD_PATH,
  defaultAboxVmVirtiofsdPath,
  resolveDoctorVirtiofsdPath,
} from "../../src/host/virtiofsdPath.js";

test("resolveDoctorVirtiofsdPath honors BAKUDO_VIRTIOFSD_PATH override", async () => {
  const result = await resolveDoctorVirtiofsdPath({
    env: { BAKUDO_VIRTIOFSD_PATH: "/custom/virtiofsd" },
    accessFn: async () => {
      throw new Error("should not probe when override is set");
    },
  });

  assert.equal(result, "/custom/virtiofsd");
});

test("resolveDoctorVirtiofsdPath prefers ~/.abox/vm/virtiofsd when executable", async () => {
  const result = await resolveDoctorVirtiofsdPath({
    env: {},
    homeDir: "/home/tester",
    accessFn: async () => undefined,
  });

  assert.equal(result, "/home/tester/.abox/vm/virtiofsd");
});

test("resolveDoctorVirtiofsdPath falls back to legacy system path when ~/.abox/vm/virtiofsd is absent", async () => {
  const result = await resolveDoctorVirtiofsdPath({
    env: {},
    homeDir: "/home/tester",
    accessFn: async () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
  });

  assert.equal(result, LEGACY_SYSTEM_VIRTIOFSD_PATH);
});

test("defaultAboxVmVirtiofsdPath mirrors abox's default state dir layout", () => {
  assert.equal(defaultAboxVmVirtiofsdPath("/home/tester"), "/home/tester/.abox/vm/virtiofsd");
});
