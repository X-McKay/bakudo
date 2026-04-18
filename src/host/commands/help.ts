/**
 * `bakudo help <topic>` — loads the bundled markdown under `docs/help/`
 * and emits it. The existing `/help` slash command continues to list
 * available slash commands; this new surface registers as
 * `/help-topic` to avoid colliding with that contract.
 */

import type { HostCommandSpec } from "../commandRegistry.js";
import { stdoutWrite } from "../io.js";
import {
  KNOWN_HELP_TOPICS,
  isKnownHelpTopic,
  listAvailableHelpTopics,
  loadHelpTopic,
  unknownTopicMessage,
} from "../helpTopicLoader.js";

/**
 * Build the "no topic" usage text. Listed topics come from the bundled
 * set plus anything present on disk; hint text points at the slash
 * command on the interactive side.
 */
export const buildHelpIndex = async (): Promise<string[]> => {
  const topics = await listAvailableHelpTopics();
  const lines: string[] = [];
  lines.push("bakudo help — long-form documentation");
  lines.push("");
  lines.push("Usage:");
  lines.push("  bakudo help                list available topics");
  lines.push("  bakudo help <topic>        print the topic contents");
  lines.push("");
  lines.push("Topics:");
  for (const topic of topics) {
    lines.push(`  ${topic}`);
  }
  return lines;
};

/**
 * CLI entrypoint. Returns an exit code: 0 on success, 1 on unknown
 * topic (so automation can detect the failure). Writes to stdout via
 * the host writer so tests can capture.
 */
export const runHelpCli = async (args: { topic?: string }): Promise<number> => {
  if (args.topic === undefined) {
    const lines = await buildHelpIndex();
    stdoutWrite(`${lines.join("\n")}\n`);
    return 0;
  }
  if (!isKnownHelpTopic(args.topic)) {
    stdoutWrite(`${unknownTopicMessage(args.topic)}\n`);
    return 1;
  }
  const loaded = await loadHelpTopic(args.topic);
  if (loaded === null) {
    stdoutWrite(
      `${unknownTopicMessage(args.topic)} (topic recognized but file not found — reinstall bakudo)\n`,
    );
    return 1;
  }
  stdoutWrite(loaded.content.endsWith("\n") ? loaded.content : `${loaded.content}\n`);
  return 0;
};

/**
 * Slash command `/help-topic <topic>`. The existing `/help` routes a
 * single-arg invocation through here when the argument matches a known
 * topic; otherwise `/help` falls through to its normal list.
 */
export const helpTopicCommandSpec: HostCommandSpec = {
  name: "help-topic",
  group: "system",
  description: "Read a bundled help topic (config, hooks, permissions, monitoring, sandbox).",
  handler: async ({ args, deps }) => {
    const topic = args[0];
    if (topic === undefined) {
      const lines = await buildHelpIndex();
      for (const line of lines) {
        deps.transcript.push({ kind: "event", label: "help", detail: line });
      }
      return;
    }
    if (!isKnownHelpTopic(topic)) {
      deps.transcript.push({
        kind: "assistant",
        text: unknownTopicMessage(topic),
        tone: "warning",
      });
      return;
    }
    const loaded = await loadHelpTopic(topic);
    if (loaded === null) {
      deps.transcript.push({
        kind: "assistant",
        text: `${unknownTopicMessage(topic)} (file missing — reinstall bakudo)`,
        tone: "error",
      });
      return;
    }
    for (const line of loaded.content.split("\n")) {
      deps.transcript.push({ kind: "event", label: "help", detail: line });
    }
  },
};

export { KNOWN_HELP_TOPICS };
