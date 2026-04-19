import assert from "node:assert/strict";
import test from "node:test";

import {
  checkKvmAccess,
  checkVirtiofsdCaps,
  type PreflightCheckResult,
} from "../../src/host/hostPreflight.js";

test("F-P: checkVirtiofsdCaps reports missing path as error", async () => {
  const result: PreflightCheckResult = await checkVirtiofsdCaps({
    virtiofsdPath: "/does/not/exist/virtiofsd",
    execFn: async () => {
      throw Object.assign(new Error("not found"), { code: "ENOENT" });
    },
  });
  assert.equal(result.status, "error");
  assert.equal(result.name, "host-virtiofsd-caps");
  assert.match(result.message, /virtiofsd/u);
});

test("F-P: checkVirtiofsdCaps reports missing cap_sys_admin as error", async () => {
  const result: PreflightCheckResult = await checkVirtiofsdCaps({
    virtiofsdPath: "/usr/libexec/virtiofsd",
    execFn: async () => ({ stdout: "\n", stderr: "" }),
  });
  assert.equal(result.status, "error");
  assert.match(result.message, /cap_sys_admin\+ep/u);
  assert.match(result.fix ?? "", /setcap 'cap_sys_admin\+ep'/u);
});

test("F-P: checkVirtiofsdCaps passes when cap is present", async () => {
  const result: PreflightCheckResult = await checkVirtiofsdCaps({
    virtiofsdPath: "/usr/libexec/virtiofsd",
    execFn: async () => ({
      stdout: "/usr/libexec/virtiofsd cap_sys_admin=ep\n",
      stderr: "",
    }),
  });
  assert.equal(result.status, "pass");
});

test("F-P: checkKvmAccess reports missing /dev/kvm as error", async () => {
  const result: PreflightCheckResult = await checkKvmAccess({
    statFn: async () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
    accessFn: async () => {
      throw new Error("unreachable when stat fails");
    },
  });
  assert.equal(result.status, "error");
  assert.equal(result.name, "host-kvm-access");
  assert.match(result.message, /\/dev\/kvm/u);
});

test("F-P: checkKvmAccess reports non-rw as error", async () => {
  const result: PreflightCheckResult = await checkKvmAccess({
    statFn: async () => ({ isCharacterDevice: () => true }),
    accessFn: async () => {
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    },
  });
  assert.equal(result.status, "error");
  assert.match(result.fix ?? "", /usermod -aG kvm/u);
});

test("F-P: checkKvmAccess passes when rw", async () => {
  const result: PreflightCheckResult = await checkKvmAccess({
    statFn: async () => ({ isCharacterDevice: () => true }),
    accessFn: async () => undefined,
  });
  assert.equal(result.status, "pass");
});
