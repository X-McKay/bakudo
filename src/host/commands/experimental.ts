/**
 * Phase 5 PR13 — `/experimental on|off|show` slash command.
 *
 * Mirrors the Copilot CLI experimental gate: `on`/`off` persist the cluster
 * state into `~/.config/bakudo/config.json` and then ask the user to restart
 * bakudo so the renderer and binding registry pick up the new config
 * (hot-swap is out of scope — see `TODO(phase5-pr14)`). `show` prints every
 * registered flag with its current state (env + config merged).
 *
 * The persistence layer writes atomically by staging to `<file>.tmp` and
 * renaming, mirroring how {@link writeDurableAllowlist} handles durable
 * data. Unknown top-level keys already present in the user config are
 * preserved so a newer bakudo writing an older user config does not drop
 * forward-compat fields.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { HostCommandSpec } from "../commandRegistry.js";
import type { BakudoConfig, ConfigLayer } from "../config.js";
import { validateConfigLayer, xdgConfigPath } from "../config.js";
import { EXPERIMENTAL_FLAGS, experimental } from "../flags.js";

/**
 * Location of the user-scoped bakudo config. Wrapped in a helper so tests
 * can monkey-patch `XDG_CONFIG_HOME` and still hit the same resolver.
 */
export const userConfigPath = (): string => xdgConfigPath("bakudo", "config.json");

/**
 * Read the current user-config JSON as an untyped record. Returns an empty
 * object when the file is missing or unparseable — the caller will validate
 * before writing. We intentionally preserve unknown keys so a forward-compat
 * field written by a newer bakudo is not lost by an older one.
 */
const readUserConfigRaw = async (path: string): Promise<Record<string, unknown>> => {
  try {
    const content = await readFile(path, "utf8");
    const parsed = JSON.parse(content) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return { ...(parsed as Record<string, unknown>) };
    }
    return {};
  } catch {
    return {};
  }
};

/**
 * Atomically write `content` to `path`. Creates parent dirs as needed,
 * stages to `<path>.tmp`, then renames — matching the durability patterns
 * in {@link approvalStore.ts}.
 */
const atomicWriteJson = async (path: string, payload: unknown): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  const tmp = `${path}.tmp`;
  await writeFile(tmp, body, { encoding: "utf8" });
  await rename(tmp, path);
};

/**
 * Persist the experimental cluster flag to the user config. `enabled` is
 * written to the top-level `experimental` key as a bare boolean (the
 * legacy shape) so existing readers understand it immediately.
 */
export const persistExperimentalCluster = async (
  enabled: boolean,
  path: string = userConfigPath(),
): Promise<void> => {
  const raw = await readUserConfigRaw(path);
  raw["experimental"] = enabled;
  // Defensive validation — the layer should still parse after our edit.
  // Invalid layers are logged but we still write, matching the tolerant
  // philosophy of the rest of the cascade (the writer did not corrupt the
  // file; we just failed to validate it, which is a user-config problem).
  validateConfigLayer(raw, `user (${path})`);
  await atomicWriteJson(path, raw);
};

const experimentalUsage = [
  "/experimental on — enable the cluster in ~/.config/bakudo/config.json (restart required).",
  "/experimental off — disable the cluster persistently (restart required).",
  "/experimental show — list every experimental feature and its current state.",
];

/**
 * Message printed after `on`/`off`. Documents the restart step explicitly.
 * TODO(phase5-pr14): implement a self-restart wrapper so users do not
 * have to re-invoke bakudo manually — until then we ask them to.
 */
const RESTART_PROMPT =
  "Restart bakudo for the change to take effect (self-restart lands in phase5-pr14).";

export type ExperimentalPrinter = (line: string) => void;

export type ExperimentalRunInput = {
  args: string[];
  print: ExperimentalPrinter;
  /** Override path for tests; defaults to the XDG user-config path. */
  configPath?: string;
  /**
   * Hook invoked after `on`/`off` succeed. In production this calls
   * `process.exit(0)` so the user re-launches bakudo with the new config;
   * tests inject a no-op. The handler prints {@link RESTART_PROMPT} before
   * calling the hook so the message is always visible.
   */
  requestRestart?: () => void;
};

/**
 * Handler for `/experimental on|off|show`. Extracted so tests can drive it
 * without booting the registry. Side effects:
 *
 *   - `on` / `off`: write to the user config, then invoke `requestRestart`.
 *   - `show`: consult {@link experimental} per flag and print the summary.
 */
export const runExperimentalCommand = async (input: ExperimentalRunInput): Promise<void> => {
  const { args, print, configPath, requestRestart } = input;
  const subcommand = args[0];

  if (subcommand === undefined) {
    print("Usage:");
    for (const line of experimentalUsage) {
      print(`  ${line}`);
    }
    return;
  }

  if (subcommand === "on" || subcommand === "off") {
    const enabled = subcommand === "on";
    await persistExperimentalCluster(enabled, configPath ?? userConfigPath());
    // Note: passing the explicit path keeps test control flow clean, even
    // though `persistExperimentalCluster` defaults to the same value.
    print(
      enabled
        ? "/experimental on: cluster enabled in user config."
        : "/experimental off: cluster disabled in user config.",
    );
    print(RESTART_PROMPT);
    if (requestRestart !== undefined) {
      requestRestart();
    }
    return;
  }

  if (subcommand === "show") {
    if (EXPERIMENTAL_FLAGS.length === 0) {
      print("/experimental show: no experimental features registered.");
      return;
    }
    print(`/experimental show: ${EXPERIMENTAL_FLAGS.length} feature(s) registered.`);
    for (const flag of EXPERIMENTAL_FLAGS) {
      const state = experimental(flag.name) ? "on" : "off";
      print(`  ${flag.name} [${state}] — ${flag.description}`);
    }
    return;
  }

  print(`Unknown /experimental subcommand: ${subcommand}`);
  print("Usage:");
  for (const line of experimentalUsage) {
    print(`  ${line}`);
  }
};

/**
 * Build the `/experimental` command spec. `getMergedConfig` is reserved for
 * future work (e.g. to report which layer a flag came from in
 * `/experimental show`) but is not required for the on/off/show semantics
 * — the env+config merge already happens inside {@link experimental}.
 */
export const buildExperimentalCommands = (
  _getMergedConfig?: () => { merged: BakudoConfig; layers: ConfigLayer[] },
): readonly HostCommandSpec[] => [
  {
    name: "experimental",
    group: "system",
    description:
      "Toggle the experimental cluster (on|off|show). on/off persist and request a restart.",
    handler: async ({ args, deps }) => {
      await runExperimentalCommand({
        args,
        print: (line) => {
          deps.transcript.push({ kind: "event", label: "experimental", detail: line });
        },
        requestRestart: () => {
          // TODO(phase5-pr14): self-restart wrapper. For now we exit with a
          // success code and rely on the transcript message above to prompt
          // the user to re-run bakudo themselves.
          const proc = (globalThis as unknown as { process?: { exit?: (code: number) => never } })
            .process;
          proc?.exit?.(0);
        },
      });
    },
  },
];
