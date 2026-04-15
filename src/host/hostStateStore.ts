import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";

import type { ComposerMode } from "./appState.js";

export const HOST_STATE_SCHEMA_VERSION = 1 as const;

export type HostStateRecord = {
  schemaVersion: typeof HOST_STATE_SCHEMA_VERSION;
  lastActiveSessionId?: string;
  lastActiveTurnId?: string;
  lastUsedMode: ComposerMode;
  autoApprove: boolean;
};

const HOST_STATE_FILE_NAME = "host-state.json";

const toResolvedPath = (repoRoot: string): string =>
  isAbsolute(repoRoot) ? repoRoot : resolve(repoRoot);

export const hostStateFilePath = (repoRoot: string): string =>
  join(toResolvedPath(repoRoot), ".bakudo", HOST_STATE_FILE_NAME);

const ensureParentDir = async (filePath: string): Promise<void> => {
  await mkdir(dirname(filePath), { recursive: true });
};

const isComposerMode = (value: unknown): value is ComposerMode =>
  value === "standard" || value === "plan" || value === "autopilot";

const normalizeMode = (value: unknown): ComposerMode => {
  if (isComposerMode(value)) {
    return value;
  }
  // Legacy TaskMode values from older host-state.json files.
  if (value === "build") {
    return "standard";
  }
  return "standard";
};

export const loadHostState = async (repoRoot: string): Promise<HostStateRecord | null> => {
  const filePath = hostStateFilePath(repoRoot);
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    return null;
  }
  if (content.trim().length === 0) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const raw = parsed as {
    schemaVersion?: unknown;
    lastActiveSessionId?: unknown;
    lastActiveTurnId?: unknown;
    lastUsedMode?: unknown;
    autoApprove?: unknown;
  };
  const mode = normalizeMode(raw.lastUsedMode);
  const record: HostStateRecord = {
    schemaVersion: HOST_STATE_SCHEMA_VERSION,
    lastUsedMode: mode,
    autoApprove: raw.autoApprove === true || mode === "autopilot",
  };
  if (typeof raw.lastActiveSessionId === "string" && raw.lastActiveSessionId.length > 0) {
    record.lastActiveSessionId = raw.lastActiveSessionId;
  }
  if (typeof raw.lastActiveTurnId === "string" && raw.lastActiveTurnId.length > 0) {
    record.lastActiveTurnId = raw.lastActiveTurnId;
  }
  return record;
};

export const saveHostState = async (repoRoot: string, record: HostStateRecord): Promise<void> => {
  const filePath = hostStateFilePath(repoRoot);
  await ensureParentDir(filePath);
  const normalized: HostStateRecord = {
    schemaVersion: HOST_STATE_SCHEMA_VERSION,
    lastUsedMode: record.lastUsedMode,
    autoApprove: record.autoApprove,
    ...(record.lastActiveSessionId ? { lastActiveSessionId: record.lastActiveSessionId } : {}),
    ...(record.lastActiveTurnId ? { lastActiveTurnId: record.lastActiveTurnId } : {}),
  };
  const tempPath = `${filePath}.tmp-${Date.now()}-${randomUUID()}`;
  await writeFile(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
};
