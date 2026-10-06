// The contract between main.ts and the command modules (src/commands/<name>.ts). main.ts parses the
// command line, runs the environment gate and builds a CommandContext; a command module exports
// `run(ctx)` and returns the exit code. Commands do not read process.argv, process.env or
// process.cwd(), and do not write with console.*: everything comes through the context, so that a
// test can run any command in-process and read what it printed.

/** The exit codes of section 4.1. */
export const EXIT = {
  /** The command did what it was asked to. */
  ok: 0,
  /** The command ran and found a problem: configuration, documents, build, checks, doctor errors. */
  problems: 1,
  /** The command line is wrong. */
  usage: 2,
  /** The environment is wrong: Node too old, workflow contract mismatch, another process holds the lock. */
  environment: 3,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/**
 * Every option of section 4.1, as main.ts parsed it. An option that was not given is undefined, so
 * `options.strict === true` means the flag was passed; `--no-workflow` is `noWorkflow: true`.
 * main.ts rejects (usage error, exit 2) an option the command does not take, and `--strict` together
 * with `--lenient`, and checks that `--port` is an integer from 0 to 65535, before a command runs.
 */
export interface CommandOptions {
  /** Global, every command except `init`: `--site <dir>`. */
  site?: string;
  /** init: `--site-dir <dir>`, relative to the repository root (default `docs-site`). */
  siteDir?: string;
  /** init: `--name`, `--tagline`, `--slug`, `--platform`, `--repo`, `--domain`, `--license`, `--branch`. */
  name?: string;
  tagline?: string;
  slug?: string;
  /** Not validated by main.ts: init checks it against PLATFORMS. */
  platform?: string;
  repo?: string;
  domain?: string;
  license?: string;
  branch?: string;
  /** init: `--docs <path>`. */
  docs?: string;
  /** init: `--from-readme`. */
  fromReadme?: boolean;
  /** init: `--no-workflow`. */
  noWorkflow?: boolean;
  /** init: `--no-dependabot`. */
  noDependabot?: boolean;
  /** init: `--no-patch-automerge`. */
  noPatchAutomerge?: boolean;
  /** init, upgrade: `--workflow-sha <sha>`. */
  workflowSha?: string;
  /** init, eject: `--force`. */
  force?: boolean;
  /** init, upgrade: `--dry-run`. */
  dryRun?: boolean;
  /** build: `--strict`. */
  strict?: boolean;
  /** build: `--lenient`. */
  lenient?: boolean;
  /** build, check: `--refresh-catalog`. */
  refreshCatalog?: boolean;
  /** check: `--ci`. */
  ci?: boolean;
  /** dev: `--port <n>`. */
  port?: number;
  /** info, doctor: `--json`. */
  json?: boolean;
  /** info: `--nav`. */
  nav?: boolean;
  /** eject: `--all`. */
  all?: boolean;
}

export interface CommandContext {
  /** The command's name: `build`. */
  command: string;
  /**
   * The positional arguments after the command name: the `[dist]` of `links`, the files of `eject`.
   * main.ts rejects positionals for the commands that take none. For `jx` this is everything after
   * the word `jx`, verbatim and unparsed (so `--site` must come before it).
   */
  args: string[];
  options: CommandOptions;
  cwd: string;
  /** The environment the command may read (4.1, "Environment"); tests pass their own. */
  env: NodeJS.ProcessEnv;
  /** Prints one line to standard output / standard error. */
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  /** Colors wanted: NO_COLOR is unset (or empty) and standard output is a terminal. */
  color: boolean;
  /** Aborted when the caller wants the command to stop; `dev` finishes cleanly and returns 0. */
  signal: AbortSignal;
}

/** A command: returns its exit code, throws only for what it did not expect (main.ts prints it, exit 1). */
export type Command = (ctx: CommandContext) => Promise<number>;

/** What `import("./commands/<name>.js")` gives main.ts. */
export interface CommandModule {
  run: Command;
}
