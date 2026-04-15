#!/usr/bin/env node

import { isMainModule } from "./mainModule.js";
import { stderrWrite } from "./host/io.js";
import { dispatchHostCommand, runInteractiveShell } from "./host/interactive.js";
import { parseHostArgs } from "./host/parsing.js";

export { reviewedOutcomeExitCode } from "./host/printers.js";
export { parseHostArgs, shouldUseHostCli } from "./host/parsing.js";
export type { HostCliArgs } from "./host/parsing.js";

export const runHostCli = async (argv: string[]): Promise<number> => {
  if (argv.length === 0) {
    return runInteractiveShell();
  }

  const args = parseHostArgs(argv);
  return dispatchHostCommand(args);
};

if (isMainModule(import.meta.url, process.argv[1])) {
  runHostCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      stderrWrite(`host_cli_error: ${message}\n`);
      process.exitCode = 1;
    });
}
