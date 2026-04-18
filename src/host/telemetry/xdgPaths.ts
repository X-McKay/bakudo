/**
 * Phase 6 Wave 6c PR7 — XDG data-path helpers for the local telemetry stack.
 *
 * Phase 5 landed {@link import("../config.js").xdgConfigPath} for the
 * `~/.config/bakudo/` namespace (config.json, keybindings.json). This module
 * is its `XDG_DATA_HOME` sibling — every file written by the telemetry stack
 * (time-delta logs, OTel spans, heap snapshots) lives under
 * `~/.local/share/bakudo/log/` by default.
 *
 * Kept in its own file (rather than extending `config.ts`) because:
 *
 *   1. `config.ts` is a cold path consumed at every bootstrap — we do not
 *      want telemetry helpers importable through the config layer.
 *   2. The telemetry stack is the only consumer of `XDG_DATA_HOME` today.
 *      Co-locating these helpers under `host/telemetry/` keeps the module
 *      graph clean.
 *
 * Both helpers respect the standard XDG env vars so sysadmin-managed
 * installs honour user overrides. On a vanilla Linux/macOS host the paths
 * collapse to the common-case defaults without requiring configuration.
 */

import { homedir } from "node:os";
import { join } from "node:path";

const getProcessEnv = (): Record<string, string | undefined> =>
  (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;

/**
 * Resolve the XDG data-home root (`$XDG_DATA_HOME` or `~/.local/share`).
 * Does not append an app segment — callers that want an app-scoped path
 * use {@link xdgDataPath}.
 */
export const xdgDataHome = (): string => {
  const override = getProcessEnv().XDG_DATA_HOME;
  if (override !== undefined && override.length > 0) {
    return override;
  }
  return join(homedir(), ".local", "share");
};

/**
 * Resolve the XDG data path for `<app>/<sub...>`. Mirrors
 * {@link import("../config.js").xdgConfigPath} on the `XDG_CONFIG_HOME` side
 * but for durable-but-recreatable data (logs, traces, snapshots).
 */
export const xdgDataPath = (app: string, ...segments: string[]): string =>
  join(xdgDataHome(), app, ...segments);

/**
 * Resolve the bakudo log directory. Standardised as
 * `<XDG_DATA_HOME>/bakudo/log/` so time-delta logs, OTel span files, and
 * V8 heap snapshots all share the same rotation namespace.
 *
 * Plan 06 lines 860, 925, 932 all reference `~/.local/share/bakudo/log/` as
 * the canonical location — this helper is the single source of truth for
 * that path.
 */
export const bakudoLogDir = (): string => xdgDataPath("bakudo", "log");
