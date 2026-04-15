#!/usr/bin/env node

import { withBootstrap } from "./host/bootstrap.js";
import { isMainModule } from "./mainModule.js";
import { stderrWrite } from "./host/io.js";
import { dispatchHostCommand, runInteractiveShell } from "./host/interactive.js";
import { parseHostArgs } from "./host/parsing.js";
import { printUsage } from "./host/usage.js";

export { reviewedOutcomeExitCode } from "./host/printers.js";
export { parseHostArgs, shouldUseHostCli } from "./host/parsing.js";
export type { HostCliArgs } from "./host/parsing.js";

const isHelpArg = (arg: string): boolean => arg === "--help" || arg === "-h" || arg === "help";

export const runHostCli = async (argv: string[]): Promise<number> => {
  // Fast-path: `bakudo --help` / `bakudo -h` / `bakudo help` skips bootstrap.
  // Target <50ms. Keep this check above `withBootstrap` on purpose.
  if (argv.length === 1 && argv[0] !== undefined && isHelpArg(argv[0])) {
    printUsage();
    return 0;
  }

  return withBootstrap(async () => {
    if (argv.length === 0) {
      return runInteractiveShell();
    }
    const args = parseHostArgs(argv);
    return dispatchHostCommand(args);
  });
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
