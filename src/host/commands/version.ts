import { BAKUDO_VERSION, buildVersionEnvelope, type VersionEnvelope } from "../../version.js";
import type { HostCommandSpec } from "../commandRegistry.js";
import { stdoutWrite } from "../io.js";

/**
 * Build the plain-text single-line form emitted for human readers.
 * Kept as a pure helper so tests can assert without capturing stdout.
 */
export const formatVersionPlain = (version: string = BAKUDO_VERSION): string => `bakudo ${version}`;

/**
 * Emit the version output. When `useJson` is true, serialize the
 * {@link VersionEnvelope} as a single JSON line; otherwise emit the plain
 * single-line form.
 */
export const printVersion = (options: { useJson?: boolean } = {}): VersionEnvelope => {
  const envelope = buildVersionEnvelope();
  if (options.useJson === true) {
    stdoutWrite(`${JSON.stringify(envelope)}\n`);
  } else {
    stdoutWrite(`${formatVersionPlain(envelope.version)}\n`);
  }
  return envelope;
};

export const versionCommandSpec: HostCommandSpec = {
  name: "version",
  group: "system",
  description: "Print the bakudo version (plain or JSON envelope).",
  handler: ({ args, deps }) => {
    const useJson = args.includes("--output-format=json") || args.includes("--json");
    const envelope = buildVersionEnvelope();
    if (useJson) {
      deps.transcript.push({
        kind: "event",
        label: "version",
        detail: JSON.stringify(envelope),
      });
    } else {
      deps.transcript.push({
        kind: "event",
        label: "version",
        detail: formatVersionPlain(envelope.version),
      });
    }
  },
};
