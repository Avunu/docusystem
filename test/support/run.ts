import type { CommandContext } from "../../src/commands/types.js";
import { run, type RunEnvironment } from "../../src/main.js";

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs the command line in-process, as `docusystem <argv>` would, and returns the exit code and what
 * was printed. The environment is empty unless given, so a developer's CI=true or NO_COLOR does not
 * leak into a test; `overrides` replaces any of what `run` reads from the process.
 */
export async function runCli(
  argv: string[],
  overrides: Partial<RunEnvironment> = {},
): Promise<CliResult> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, {
    env: {},
    color: false,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    ...overrides,
  });
  return { code, stdout: out.join("\n"), stderr: err.join("\n") };
}

/**
 * A CommandContext for calling a command's `run` directly: empty environment, no color, and the
 * lines it prints collected in `stdout` and `stderr`.
 */
export function testContext(partial: Partial<CommandContext> & { command: string }): {
  ctx: CommandContext;
  stdout: string[];
  stderr: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const ctx: CommandContext = {
    args: [],
    options: {},
    cwd: process.cwd(),
    env: {},
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
    color: false,
    signal: new AbortController().signal,
    ...partial,
  };
  return { ctx, stdout, stderr };
}
