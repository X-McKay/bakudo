import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const LEGACY_SYSTEM_VIRTIOFSD_PATH = "/usr/libexec/virtiofsd";

export type ResolveDoctorVirtiofsdPathInput = {
  env: Record<string, string | undefined>;
  homeDir?: string;
  accessFn?: (path: string, mode: number) => Promise<void>;
};

export const defaultAboxVmVirtiofsdPath = (homeDir = homedir()): string =>
  join(homeDir, ".abox", "vm", "virtiofsd");

export const resolveDoctorVirtiofsdPath = async (
  input: ResolveDoctorVirtiofsdPathInput,
): Promise<string> => {
  const configured = input.env.BAKUDO_VIRTIOFSD_PATH?.trim();
  if (configured !== undefined && configured.length > 0) {
    return configured;
  }

  const candidate = defaultAboxVmVirtiofsdPath(input.homeDir);
  const accessFn = input.accessFn ?? access;
  try {
    await accessFn(candidate, fsConstants.X_OK);
    return candidate;
  } catch {
    return LEGACY_SYSTEM_VIRTIOFSD_PATH;
  }
};
