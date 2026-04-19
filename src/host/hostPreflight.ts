import { execFile } from "node:child_process";
import { constants as fsConstants, type Stats } from "node:fs";
import { access, stat } from "node:fs/promises";
import { promisify } from "node:util";

import type { DoctorCheckResult } from "./doctorCheck.js";

const execFileAsync = promisify(execFile);
const CAP_SYS_ADMIN_EP_PATTERN = /cap_sys_admin[^\s]*=ep/u;

export type PreflightCheckResult = {
  name: "host-virtiofsd-caps" | "host-kvm-access";
  status: "pass" | "error";
  message: string;
  fix?: string;
};

type ExecResult = {
  stdout: string;
  stderr: string;
};

export type CheckVirtiofsdCapsInput = {
  virtiofsdPath: string;
  execFn?: (cmd: string, args: readonly string[]) => Promise<ExecResult>;
};

const defaultExecFn = async (cmd: string, args: readonly string[]): Promise<ExecResult> => {
  const { stdout, stderr } = await execFileAsync(cmd, [...args], {
    encoding: "utf8",
  });
  return {
    stdout: String(stdout),
    stderr: String(stderr),
  };
};

export const checkVirtiofsdCaps = async (
  input: CheckVirtiofsdCapsInput,
): Promise<PreflightCheckResult> => {
  const execFn = input.execFn ?? defaultExecFn;
  try {
    const { stdout } = await execFn("getcap", [input.virtiofsdPath]);
    if (!CAP_SYS_ADMIN_EP_PATTERN.test(stdout)) {
      return {
        name: "host-virtiofsd-caps",
        status: "error",
        message: `virtiofsd at ${input.virtiofsdPath} lacks required capabilities (need cap_sys_admin+ep).`,
        fix: `sudo setcap 'cap_sys_admin+ep' ${input.virtiofsdPath}`,
      };
    }
    return {
      name: "host-virtiofsd-caps",
      status: "pass",
      message: `virtiofsd at ${input.virtiofsdPath} has cap_sys_admin+ep`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      name: "host-virtiofsd-caps",
      status: "error",
      message: `unable to probe virtiofsd at ${input.virtiofsdPath}: ${message}`,
      fix: `sudo setcap 'cap_sys_admin+ep' ${input.virtiofsdPath}`,
    };
  }
};

type CharacterDeviceStat = Pick<Stats, "isCharacterDevice">;

export type CheckKvmAccessInput = {
  kvmPath?: string;
  statFn?: (path: string) => Promise<CharacterDeviceStat>;
  accessFn?: (path: string, mode: number) => Promise<void>;
};

const currentUid = (): string => {
  const uid = (
    globalThis as unknown as { process?: { getuid?: () => number } }
  ).process?.getuid?.();
  return uid === undefined ? "unknown" : String(uid);
};

export const checkKvmAccess = async (
  input: CheckKvmAccessInput = {},
): Promise<PreflightCheckResult> => {
  const kvmPath = input.kvmPath ?? "/dev/kvm";
  const statFn = input.statFn ?? stat;
  const accessFn = input.accessFn ?? access;

  try {
    const statResult = await statFn(kvmPath);
    if (!statResult.isCharacterDevice()) {
      return {
        name: "host-kvm-access",
        status: "error",
        message: `${kvmPath} not accessible for uid=${currentUid()}.`,
        fix: "sudo usermod -aG kvm $USER (log out and back in)",
      };
    }
  } catch {
    return {
      name: "host-kvm-access",
      status: "error",
      message: `${kvmPath} not accessible for uid=${currentUid()}.`,
      fix: "sudo usermod -aG kvm $USER (log out and back in)",
    };
  }

  try {
    await accessFn(kvmPath, fsConstants.R_OK | fsConstants.W_OK);
  } catch {
    return {
      name: "host-kvm-access",
      status: "error",
      message: `${kvmPath} not accessible for uid=${currentUid()}.`,
      fix: "sudo usermod -aG kvm $USER (log out and back in)",
    };
  }

  return {
    name: "host-kvm-access",
    status: "pass",
    message: `${kvmPath} readable/writable`,
  };
};

export const preflightToDoctorCheck = (result: PreflightCheckResult): DoctorCheckResult => ({
  name: result.name,
  status: result.status === "pass" ? "pass" : "fail",
  summary: result.message,
  ...(result.fix !== undefined ? { remediation: result.fix } : {}),
});
