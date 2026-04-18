/**
 * Phase 6 Wave 6e PR16 — `.bakudo/` → XDG migration on first launch.
 *
 * Plan reference: `plans/bakudo-ux/06-rollout-reliability-and-operability.md`
 * §Migration From Current `.bakudo/` Layout (lines 811–819).
 *
 * Four rules (plan 813–818):
 *   1. First launch of a new version detects the legacy layout, migrates
 *      user-global bits to XDG, leaves repo-local bits in place.
 *   2. Migration is one-way and logs a single `host.migration_v1_to_v2`
 *      event (rides `host.event_skipped` per lock-in 6).
 *   3. The legacy detector stays for one release cycle; see `TODO(phase-7)`.
 *   4. `bakudo doctor` reports which layout is in use (wired in `doctor.ts`).
 *
 * User-global vs repo-local split (audit of current `.bakudo/` usage):
 *
 *   REPO-LOCAL (STAY PUT — never touched by this migrator):
 *     - `<repo>/.bakudo/config.json`      repo-specific config overlay
 *     - `<repo>/.bakudo/host-state.json`  active repo-local session state
 *     - `<repo>/.bakudo/sessions/`        per-repo session store
 *     - `<repo>/.bakudo/approvals.jsonl`  durable per-repo approvals
 *
 *   USER-GLOBAL (MIGRATE to `<bakudoLogDir()>`):
 *     - `<repo>/.bakudo/log/`             startup-profiler output
 *     - `<home>/.bakudo/log/`             legacy user-home log dir
 *     - `<home>/.bakudo/spans/`           legacy user-home spans dir
 *
 * Idempotence marker: zero-byte sentinel at
 * `<bakudoLogDir()>/.migrated-v1-to-v2` is written LAST (after all renames)
 * so a mid-migration crash leaves the marker absent and the next launch
 * retries from still-present legacy sources.
 */

import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { posix as posixPath } from "node:path";

import { createSessionEvent, type SessionEventEnvelope } from "../protocol.js";

/**
 * Minimal filesystem surface the migrator needs. Narrow so the unit test
 * can inject an in-memory fake; production wires {@link realMigrationFs}.
 */
export type MigrationFs = {
  stat: (path: string) => Promise<{ isDirectory: () => boolean } | null>;
  mkdir: (path: string, opts: { recursive: boolean }) => Promise<void>;
  rename: (src: string, dst: string) => Promise<void>;
  writeFile: (path: string, data: string) => Promise<void>;
  exists: (path: string) => Promise<boolean>;
};

export type MigrationPaths = {
  /** Repo root — typically the current working directory. */
  repoRoot: string;
  /** Resolved home directory (e.g. `/home/al`). */
  home: string;
  /** XDG log directory — migration destination. */
  xdgLogDir: string;
};

export type LayoutDetection = {
  layout: "legacy" | "xdg";
  /** Legacy directories that will be migrated. Empty on `"xdg"`. */
  legacyPaths: string[];
};

export type MigrationResult = {
  outcome: "migrated" | "already-xdg";
  migratedPaths: string[];
  destDir: string;
  markerPath: string;
};

/** Stable payload discriminator (lock-in 6). */
export const MIGRATION_V1_TO_V2_SKIPPED_KIND = "host.migration_v1_to_v2" as const;

export const MIGRATION_MARKER_FILENAME = ".migrated-v1-to-v2";

/**
 * TODO(phase-7): remove this detector + `migrateToXdg` one release cycle
 * after PR16 ships (plan rule 3).
 */
export const legacySourcesFor = (paths: MigrationPaths): string[] => [
  posixPath.join(paths.repoRoot, ".bakudo", "log"),
  posixPath.join(paths.home, ".bakudo", "log"),
  posixPath.join(paths.home, ".bakudo", "spans"),
];

const markerPathFor = (paths: MigrationPaths): string =>
  posixPath.join(paths.xdgLogDir, MIGRATION_MARKER_FILENAME);

/**
 * Read-only layout detector. Safe to call from `bakudo doctor`.
 *
 * TODO(phase-7): remove one release cycle after PR16 ships.
 */
export const detectLegacyLayout = async (
  fs: MigrationFs,
  paths: MigrationPaths,
): Promise<LayoutDetection> => {
  if (await fs.exists(markerPathFor(paths))) {
    return { layout: "xdg", legacyPaths: [] };
  }
  const legacy: string[] = [];
  for (const candidate of legacySourcesFor(paths)) {
    const st = await fs.stat(candidate).catch(() => null);
    if (st !== null && st.isDirectory()) {
      legacy.push(candidate);
    }
  }
  return legacy.length === 0
    ? { layout: "xdg", legacyPaths: [] }
    : { layout: "legacy", legacyPaths: legacy };
};

export type MigrationEmit = (envelope: SessionEventEnvelope) => void;

export type MigrateInput = {
  fs: MigrationFs;
  paths: MigrationPaths;
  /** Called exactly once on successful transition; never on `already-xdg`. */
  emit: MigrationEmit;
  /** Test hook — override timestamp for deterministic goldens. */
  timestamp?: string;
  /** Test hook — override the synthetic session id. */
  sessionId?: string;
};

/**
 * Execute the migration. Idempotent: repeat invocations after a successful
 * run return `{outcome: "already-xdg"}` without touching the filesystem and
 * without invoking `emit`.
 *
 * Safety: each legacy source is renamed under a non-colliding basename.
 * Destination collisions get a `-legacy-<n>` suffix so nothing is
 * overwritten — the plan's "one-way, no rollback" rule disallows
 * destructive replacement. A rename error propagates and leaves the marker
 * unwritten; the next launch retries from the still-present source.
 *
 * A first launch that finds nothing to migrate ALSO writes the marker so
 * subsequent launches short-circuit without a filesystem scan. No event is
 * emitted in that case.
 */
export const migrateToXdg = async (input: MigrateInput): Promise<MigrationResult> => {
  const { fs, paths, emit } = input;
  const destDir = paths.xdgLogDir;
  const markerPath = markerPathFor(paths);

  if (await fs.exists(markerPath)) {
    return { outcome: "already-xdg", migratedPaths: [], destDir, markerPath };
  }

  const legacyPaths = (await detectLegacyLayout(fs, paths)).legacyPaths;

  await fs.mkdir(destDir, { recursive: true });

  if (legacyPaths.length === 0) {
    await fs.writeFile(markerPath, "");
    return { outcome: "already-xdg", migratedPaths: [], destDir, markerPath };
  }

  const moved: string[] = [];
  let suffixCounter = 0;
  for (const src of legacyPaths) {
    const baseName = suggestDestName(src);
    let dstName = baseName;
    for (let i = 0; i < 1000; i += 1) {
      const candidate = posixPath.join(destDir, dstName);
      if (!(await fs.exists(candidate))) break;
      suffixCounter += 1;
      dstName = `${baseName}-legacy-${suffixCounter}`;
    }
    const finalDst = posixPath.join(destDir, dstName);
    // Rename errors propagate; marker stays unwritten → next launch retries.
    await fs.rename(src, finalDst);
    moved.push(src);
  }

  await fs.writeFile(markerPath, "");

  const envelope = buildMigrationEventEnvelope({
    sessionId: input.sessionId ?? "bakudo-bootstrap",
    migratedPaths: moved,
    destDir,
    ...(input.timestamp !== undefined ? { timestamp: input.timestamp } : {}),
  });
  try {
    emit(envelope);
  } catch {
    // Emission failure MUST NOT roll back a successful migration. Marker is
    // already in place → next launch is a clean no-op; only the diagnostic
    // signal is lost (acceptable per lock-in 6 fire-and-forget).
  }

  return { outcome: "migrated", migratedPaths: moved, destDir, markerPath };
};

/**
 * Choose a human-readable destination basename for a migrated legacy dir.
 * Operators scanning `bakudoLogDir()` can tell at a glance which source
 * each entry came from.
 */
const suggestDestName = (src: string): string => {
  if (src.endsWith("/.bakudo/spans")) {
    return "spans-legacy";
  }
  const segments = src.split("/").filter((s) => s.length > 0);
  const bakudoIdx = segments.lastIndexOf(".bakudo");
  if (bakudoIdx <= 0) {
    return "legacy-log";
  }
  const parentSegment = segments[bakudoIdx - 1] ?? "";
  const trailing = segments[segments.length - 1] ?? "log";
  const looksLikeHome = segments[0] === "home" && bakudoIdx === 2;
  if (looksLikeHome) {
    return `${trailing}-legacy`;
  }
  return `repo-${parentSegment}-${trailing}`;
};

export type BuildMigrationEventInput = {
  sessionId: string;
  migratedPaths: string[];
  destDir: string;
  timestamp?: string;
};

/**
 * Pure envelope builder exported for test isolation — pins the
 * `host.event_skipped` + `payload.skippedKind` shape independent of fs.
 */
export const buildMigrationEventEnvelope = (
  input: BuildMigrationEventInput,
): SessionEventEnvelope =>
  createSessionEvent({
    kind: "host.event_skipped",
    sessionId: input.sessionId,
    actor: "host",
    payload: {
      skippedKind: MIGRATION_V1_TO_V2_SKIPPED_KIND,
      migratedPaths: input.migratedPaths,
      destDir: input.destDir,
      from: "v1",
      to: "v2",
    },
    ...(input.timestamp !== undefined ? { timestamp: input.timestamp } : {}),
  });

/**
 * Production {@link MigrationFs} wired to `node:fs/promises`. Shared between
 * `bootstrap.ts` (migrator) and `doctor.ts` (read-only detector).
 *
 * When a `mutate: false` flavor is supplied (doctor), `mkdir`/`rename`/
 * `writeFile` throw — defense-in-depth so a future caller that misuses the
 * read-only path cannot silently mutate state.
 */
export const realMigrationFs = (opts: { mutate: boolean }): MigrationFs => ({
  stat: async (p) => {
    try {
      const st = await stat(p);
      return { isDirectory: () => st.isDirectory() };
    } catch {
      return null;
    }
  },
  mkdir: async (p, o) => {
    if (!opts.mutate) throw new Error("migration fs is read-only here");
    await mkdir(p, o);
  },
  rename: async (src, dst) => {
    if (!opts.mutate) throw new Error("migration fs is read-only here");
    await rename(src, dst);
  },
  writeFile: async (p, data) => {
    if (!opts.mutate) throw new Error("migration fs is read-only here");
    await writeFile(p, data, "utf8");
  },
  exists: async (p) => {
    try {
      await stat(p);
      return true;
    } catch {
      return false;
    }
  },
});
