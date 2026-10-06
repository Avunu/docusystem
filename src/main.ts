// The command line of `docusystem` (section 4.1 of the architecture decision record): the
// environment gate, argument parsing, the command table, help and exit codes. The commands
// themselves live in ./commands/<name>.ts and are loaded only when they are run.
//
//   0  success
//   1  the command ran and found a problem (or failed unexpectedly)
//   2  usage error: unknown command or option, an option the command does not take, bad arguments
//   3  environment: Node too old, workflow contract mismatch, another docusystem holds the lock
//
// `run` takes everything it would read from the process as an optional second argument, so tests
// (and the gate's own test, which needs a Node version that is not the one running) can inject it.
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import {
  EXIT,
  type CommandContext,
  type CommandModule,
  type CommandOptions,
} from "./commands/types.js";
import { LockError } from "./lib/lock.js";
import { NODE_FLOOR, REPOSITORY, WORKFLOW_CONTRACT, name, version } from "./lib/package-info.js";
import { PLATFORMS } from "./lib/platforms.js";

/** Everything `run` reads from the process; each field can be replaced. */
export interface RunEnvironment {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** The Node version the environment gate checks: `process.versions.node`. */
  nodeVersion: string;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  color: boolean;
  signal: AbortSignal;
}

// ---- the options ----

interface OptionSpec {
  type: "string" | "boolean";
  /** The key of CommandOptions the value goes to. */
  key: keyof CommandOptions;
  /** The placeholder of a value in help text. */
  arg?: string;
  help: string;
}

const OPTIONS = {
  site: {
    type: "string",
    key: "site",
    arg: "dir",
    help: "The site folder (the one with docusystem.config.json). Default: the current folder, else ./docs-site.",
  },
  "site-dir": {
    type: "string",
    key: "siteDir",
    arg: "dir",
    help: "Where to write the site folder, relative to the repository root. Default: docs-site.",
  },
  name: {
    type: "string",
    key: "name",
    arg: "text",
    help: "The project's display name. Default: the catalog title.",
  },
  tagline: {
    type: "string",
    key: "tagline",
    arg: "text",
    help: "One sentence about the project. Default: the catalog summary.",
  },
  slug: {
    type: "string",
    key: "slug",
    arg: "slug",
    help: "The project's key in the avunu.net catalog. Default: inferred from the repository.",
  },
  platform: {
    type: "string",
    key: "platform",
    arg: PLATFORMS.join("|"),
    help: "The platform the project belongs to. Default: the catalog's, else general.",
  },
  repo: {
    type: "string",
    key: "repo",
    arg: "url",
    help: "https://github.com/<owner>/<name>. Default: the origin remote.",
  },
  domain: {
    type: "string",
    key: "domain",
    arg: "domain",
    help: "Where the site is published. Default: <slug>.avunu.net, with _ written as -.",
  },
  license: {
    type: "string",
    key: "license",
    arg: "id",
    help: "The project's license. Default: the catalog's.",
  },
  branch: {
    type: "string",
    key: "branch",
    arg: "name",
    help: "Write the default branch into the config. Default: not written, found at build time.",
  },
  docs: {
    type: "string",
    key: "docs",
    arg: "path",
    help: "The Markdown folder, relative to the site folder. Default: ../docs.",
  },
  "from-readme": {
    type: "boolean",
    key: "fromReadme",
    help: "When docs/ has no README.md or index.md, copy the repository's README there.",
  },
  "no-workflow": {
    type: "boolean",
    key: "noWorkflow",
    help: "Do not write the two caller workflows.",
  },
  "no-dependabot": {
    type: "boolean",
    key: "noDependabot",
    help: "Do not add Dependabot entries.",
  },
  "no-patch-automerge": {
    type: "boolean",
    key: "noPatchAutomerge",
    help: "Do not patch an existing Dependabot auto-merge workflow.",
  },
  "workflow-sha": {
    type: "string",
    key: "workflowSha",
    arg: "sha",
    help: "Pin the workflows to this commit instead of resolving the tag of the installed version.",
  },
  force: {
    type: "boolean",
    key: "force",
    help: "Overwrite what init or eject would refuse to overwrite.",
  },
  "dry-run": {
    type: "boolean",
    key: "dryRun",
    help: "Print every file and change, write nothing.",
  },
  strict: {
    type: "boolean",
    key: "strict",
    help: "Fail on any document problem. Implied by CI=true.",
  },
  lenient: {
    type: "boolean",
    key: "lenient",
    help: "Report document problems as warnings while you work through them.",
  },
  "refresh-catalog": {
    type: "boolean",
    key: "refreshCatalog",
    help: "Fetch the live project catalog instead of using the bundled one (the only network access).",
  },
  ci: {
    type: "boolean",
    key: "ci",
    help: "GitHub Actions annotations, job summary and step outputs. Implied by GITHUB_ACTIONS=true.",
  },
  port: {
    type: "string",
    key: "port",
    arg: "n",
    help: "The port to serve on, 127.0.0.1 only. Default: 3000.",
  },
  json: {
    type: "boolean",
    key: "json",
    help: "Print JSON.",
  },
  nav: {
    type: "boolean",
    key: "nav",
    help: "Print the sidebar tree.",
  },
  all: {
    type: "boolean",
    key: "all",
    help: "Every file the package can eject.",
  },
} as const satisfies Record<string, OptionSpec>;

type OptionName = keyof typeof OPTIONS;

const SPECS: Record<string, OptionSpec> = OPTIONS;

/** The options of every command, and of no command: handled before a command is looked at. */
const GLOBAL = {
  version: { type: "boolean", short: "v" },
  help: { type: "boolean", short: "h" },
} as const;

const PARSE_OPTIONS: ParseArgsOptionsConfig = {
  ...Object.fromEntries(
    Object.keys(OPTIONS).map((option) => [option, { type: SPECS[option]!.type }]),
  ),
  ...GLOBAL,
};

// ---- the commands ----

interface CommandSpec {
  /** The arguments, as the usage line shows them. */
  usage: string;
  /** One line, for the list of commands. */
  summary: string;
  /** What the command does, for `docusystem <command> --help`. */
  description: string;
  /** The options it takes besides the global ones (and `--site`, which every command but `init` takes). */
  options: readonly OptionName[];
  /** How many positional arguments: none, at most one, or any number (`jx`: everything after it, verbatim). */
  positionals: "none" | "one" | "many" | "verbatim";
  load: () => Promise<CommandModule>;
}

const COMMANDS = {
  init: {
    usage:
      "[--site-dir <dir>] [--name <text>] [--tagline <text>] [--slug <slug>] [--platform <platform>]\n" +
      "                [--repo <url>] [--domain <domain>] [--license <id>] [--branch <name>] [--docs <path>]\n" +
      "                [--from-readme] [--no-workflow] [--no-dependabot] [--no-patch-automerge]\n" +
      "                [--workflow-sha <sha>] [--force] [--dry-run]",
    summary: "Write the shell of a docs site into a repository",
    description:
      "Writes docusystem.config.json, package.json, .gitignore, the two caller workflows and the\n" +
      "Dependabot entries. Run it at the repository root or inside the site folder. Values it can infer\n" +
      '(from the origin remote and the project catalog) are printed under "chosen for you".',
    options: [
      "site-dir",
      "name",
      "tagline",
      "slug",
      "platform",
      "repo",
      "domain",
      "license",
      "branch",
      "docs",
      "from-readme",
      "no-workflow",
      "no-dependabot",
      "no-patch-automerge",
      "workflow-sha",
      "force",
      "dry-run",
    ],
    positionals: "none",
    load: () => import("./commands/init.js"),
  },
  build: {
    usage: "[--strict | --lenient] [--refresh-catalog]",
    summary: "Build the site into <site>/dist",
    description:
      "Assembles the Jx project, runs Jx, post-processes and checks the output, and publishes it to\n" +
      "<site>/dist. With CI=true (or --strict) any document problem fails the build.",
    options: ["strict", "lenient", "refresh-catalog"],
    positionals: "none",
    load: () => import("./commands/build.js"),
  },
  check: {
    usage: "[--ci] [--refresh-catalog]",
    summary: "What CI runs: a strict build, the contrast gate and a link crawl",
    description:
      "A strict build, then the WCAG contrast gate on the resolved design tokens, then a crawl of every\n" +
      "link, anchor, asset, search result and sidebar entry of <site>/dist.",
    options: ["ci", "refresh-catalog"],
    positionals: "none",
    load: () => import("./commands/check.js"),
  },
  dev: {
    usage: "[--port <n>]",
    summary: "Serve the site and rebuild when the Markdown changes",
    description:
      "Builds once, serves what would be deployed on 127.0.0.1, rebuilds on every change and reloads\n" +
      "the browser. Always lenient.",
    options: ["port"],
    positionals: "none",
    load: () => import("./commands/dev.js"),
  },
  lint: {
    usage: "",
    summary: "Check the Markdown only, as file:line messages",
    description: "The Markdown checks of the build, without building.",
    options: [],
    positionals: "none",
    load: () => import("./commands/lint.js"),
  },
  links: {
    usage: "[dist]",
    summary: "Crawl an already built site",
    description: "Checks every link, anchor and asset of a built site. Default: <site>/dist.",
    options: [],
    positionals: "one",
    load: () => import("./commands/links.js"),
  },
  info: {
    usage: "[--json] [--nav]",
    summary: "Show versions, folders, overrides and how to run Jx by hand",
    description:
      "Versions, runtime, folders, the resolved branch, overrides and the exact command that runs Jx by\n" +
      "hand on the assembled project; --nav prints the sidebar tree.",
    options: ["json", "nav"],
    positionals: "none",
    load: () => import("./commands/info.js"),
  },
  doctor: {
    usage: "[--json]",
    summary: "Check the repository against the maintainer checklist (offline)",
    description:
      "Checks what a clone shows: config, workflows, Dependabot, lockfile, overrides. Prints the GitHub\n" +
      "and DNS settings a maintainer still has to make. Exit 1 on any error; warnings are allowed.",
    options: ["json"],
    positionals: "none",
    load: () => import("./commands/doctor.js"),
  },
  upgrade: {
    usage: "[--dry-run] [--workflow-sha <sha>]",
    summary: "After an update, re-pin the workflows to the installed version",
    description:
      "Re-pins both `uses:` lines of both caller workflows to the commit of the tag of the installed\n" +
      "version and adds missing Dependabot entries. It changes nothing else.",
    options: ["dry-run", "workflow-sha"],
    positionals: "none",
    load: () => import("./commands/upgrade.js"),
  },
  eject: {
    usage: "(<components/file> | <layouts/file> | <pages/file>)... | --all  [--force]",
    summary: "Copy package files into overrides/ so that they can be changed",
    description:
      "Copies package files into <site>/overrides/ and records them in overrides/.ejected.json. An\n" +
      "ejected file no longer follows package updates; `doctor` reports when the package's file changed.",
    options: ["all", "force"],
    positionals: "many",
    load: () => import("./commands/eject.js"),
  },
  jx: {
    usage: "<jx arguments...>",
    summary: "Run the pinned Jx CLI on the assembled project (debugging)",
    description:
      "Assembles the project root (docusystem builds nothing itself), then runs `jx <arguments> <root>` with the Jx this\n" +
      "version is pinned to, for example `docusystem jx build --verbose`. Everything after `jx` goes to Jx\n" +
      "unchanged, so give --site before it. `jx dev` and Studio are not supported.",
    options: [],
    positionals: "verbatim",
    load: () => import("./commands/jx.js"),
  },
} as const satisfies Record<string, CommandSpec>;

type CommandName = keyof typeof COMMANDS;

// ---- help ----

const EXIT_CODES =
  "Exit codes: 0 ok; 1 problems found; 2 usage error; 3 environment (Node older than " +
  `${NODE_FLOOR},\nworkflow contract mismatch, another docusystem running).`;

export function helpText(): string {
  const names = Object.keys(COMMANDS) as CommandName[];
  const width = Math.max(...names.map((n) => n.length));
  return [
    `${name} ${version}: the documentation system of Avunu's open-source projects`,
    "",
    "Usage: docusystem <command> [options]",
    "",
    "Commands:",
    ...names.map((n) => `  ${n.padEnd(width)}  ${COMMANDS[n].summary}`),
    "",
    "Options:",
    "  --site <dir>   The site folder: the one with docusystem.config.json. Default: the current",
    "                 folder, else ./docs-site. (Every command but init.)",
    "  -v, --version  Print the version.",
    "  -h, --help     Print this help; after a command, that command's help.",
    "",
    `Run "docusystem <command> --help" for the options of a command.`,
    EXIT_CODES,
    "",
  ].join("\n");
}

export function commandHelp(command: CommandName): string {
  const spec = COMMANDS[command];
  const taken: OptionName[] = command === "init" ? [...spec.options] : ["site", ...spec.options];
  const label = (option: OptionName): string => {
    const arg = SPECS[option]?.arg;
    return `--${option}${arg === undefined ? "" : ` <${arg}>`}`;
  };
  const width = Math.max(0, ...taken.map((option) => label(option).length));
  return [
    `Usage: docusystem ${command}${spec.usage === "" ? "" : ` ${spec.usage}`}`,
    "",
    spec.description,
    ...(taken.length === 0
      ? []
      : ["", "Options:", ...taken.map((o) => `  ${label(o).padEnd(width)}  ${OPTIONS[o].help}`)]),
    "",
    EXIT_CODES,
    "",
  ].join("\n");
}

// ---- the environment gate ----

const VERSION = /^(\d+)\.(\d+)\.(\d+)/;

/** Whether `actual` (`22.19.0`, a leading `v` and a pre-release suffix are ignored) is `floor` or newer. */
export function atLeast(actual: string, floor: string): boolean {
  const have = VERSION.exec(actual.replace(/^v/, ""));
  const want = VERSION.exec(floor);
  if (have === null || want === null) return false;
  for (let i = 1; i <= 3; i++) {
    const [a, b] = [Number(have[i]), Number(want[i])];
    if (a !== b) return a > b;
  }
  return true;
}

/**
 * Section 4.1, exit 3, and the first thing that runs: a message when the environment cannot run this
 * version at all, else null. The Node floor comes first; then the workflow contract: the reusable
 * workflow (docs-build.yml) exports the integer it was written for as DOCUSYSTEM_WORKFLOW_CONTRACT,
 * and a different one means the `uses:` pin and the installed package have drifted apart.
 */
export function environmentProblem(o: {
  nodeVersion: string;
  env: NodeJS.ProcessEnv;
}): string | null {
  if (!atLeast(o.nodeVersion, NODE_FLOOR)) {
    return (
      `Node ${o.nodeVersion} is too old: ${name} ${version} needs Node ${NODE_FLOOR} or newer ` +
      "(Bun 1.4 or newer also works). Install a current Node from https://nodejs.org/ and run it again."
    );
  }
  const wanted = o.env.DOCUSYSTEM_WORKFLOW_CONTRACT;
  if (wanted === undefined || wanted === "" || wanted === String(WORKFLOW_CONTRACT)) return null;
  return [
    `The workflow that ran this command is written for workflow contract ${wanted}, but ${name} ${version} implements contract ${WORKFLOW_CONTRACT}.`,
    "Fix: change the `uses:` lines",
    `  uses: ${REPOSITORY}/.github/workflows/docs-build.yml@<commit> # v<x.y.z>`,
    `  uses: ${REPOSITORY}/.github/workflows/docs-deploy.yml@<commit> # v<x.y.z>`,
    `in .github/workflows/docs.yml and docs-publish.yml to the commit of the tag v${version} (\`docusystem upgrade\` does this), or install the ${name} release that matches the workflow.`,
  ].join("\n");
}

// ---- running ----

const stdoutLine = (line: string): void => {
  process.stdout.write(`${line}\n`);
};
const stderrLine = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

/** Node's own wording without its hint about `--`, which does not help here. */
const plain = (message: string): string => message.replace(/\. To specify a positional.*$/s, ".");

/** Prints what went wrong in a command that threw, and says which exit code it is. */
function reportFailure(error: unknown, io: RunEnvironment): number {
  if (error instanceof LockError) {
    io.stderr(`docusystem: ${error.message}`);
    return EXIT.environment;
  }
  if (
    error instanceof TypeError ||
    error instanceof RangeError ||
    error instanceof ReferenceError ||
    error instanceof SyntaxError
  ) {
    io.stderr(`docusystem: internal error: ${error.stack ?? error.message}`);
    io.stderr(`This is a bug in ${name} ${version}: https://github.com/${REPOSITORY}/issues`);
    return EXIT.problems;
  }
  io.stderr(`docusystem: ${error instanceof Error ? error.message : String(error)}`);
  return EXIT.problems;
}

/** A usage error: the message, then the usage of the command (or the general help), on standard error. */
function usageError(io: RunEnvironment, message: string, command?: CommandName): number {
  io.stderr(`docusystem: ${message}`);
  io.stderr("");
  io.stderr((command === undefined ? helpText() : commandHelp(command)).trimEnd());
  return EXIT.usage;
}

/**
 * Runs the command line `argv` (without `node` and the script) and returns the exit code; the caller
 * (cli.ts) sets it on the process. Nothing here calls process.exit.
 */
export async function run(
  argv: string[],
  overrides: Partial<RunEnvironment> = {},
): Promise<number> {
  const env = overrides.env ?? process.env;
  const io: RunEnvironment = {
    cwd: process.cwd(),
    env,
    nodeVersion: process.versions.node,
    stdout: stdoutLine,
    stderr: stderrLine,
    color: (env.NO_COLOR ?? "") === "" && process.stdout.isTTY === true,
    signal: new AbortController().signal,
    ...overrides,
  };

  // Step 0 of the pipeline: before any other work, whatever the command line says.
  const problem = environmentProblem(io);
  if (problem !== null) {
    io.stderr(`docusystem: ${problem}`);
    return EXIT.environment;
  }

  // `jx` hands everything after it to Jx, so only what comes before it is parsed here.
  let own = argv;
  let verbatim: string[] = [];
  try {
    const scan = parseArgs({
      args: argv,
      options: PARSE_OPTIONS,
      allowPositionals: true,
      strict: false,
      tokens: true,
    });
    const first = scan.tokens.find((token) => token.kind === "positional");
    if (first?.kind === "positional" && first.value === "jx") {
      own = argv.slice(0, first.index + 1);
      verbatim = argv.slice(first.index + 1);
    }
  } catch (error) {
    return usageError(io, plain((error as Error).message));
  }

  let parsed;
  try {
    parsed = parseArgs({ args: own, options: PARSE_OPTIONS, allowPositionals: true });
  } catch (error) {
    return usageError(io, plain((error as Error).message));
  }
  const { values, positionals } = parsed;
  const [word, ...args] = positionals;

  if (values.version === true) {
    io.stdout(version);
    return EXIT.ok;
  }
  if (word === undefined) {
    io.stdout(helpText().trimEnd());
    return EXIT.ok;
  }
  if (!Object.hasOwn(COMMANDS, word)) return usageError(io, `unknown command "${word}"`);
  const command = word as CommandName;
  const spec: CommandSpec = COMMANDS[command];
  if (values.help === true) {
    io.stdout(commandHelp(command).trimEnd());
    return EXIT.ok;
  }

  // Options: each must be one the command takes.
  const takes = new Set<string>(spec.options);
  if (command !== "init") takes.add("site");
  const options: Record<string, string | boolean | number> = {};
  for (const [option, value] of Object.entries(values)) {
    if (option === "version" || option === "help" || value === undefined) continue;
    if (!takes.has(option)) {
      const hint =
        option === "site" && command === "init"
          ? ` (init takes --site-dir, relative to the repository root)`
          : "";
      return usageError(io, `${command} does not take --${option}${hint}`, command);
    }
    // `--site=` or `--name ""`: no option has an empty value that means something, and a command
    // should not have to tell "" from "not given".
    if (value === "") return usageError(io, `--${option} needs a value`, command);
    options[SPECS[option]!.key] = value as string | boolean;
  }
  if (spec.positionals === "none" && args.length > 0) {
    return usageError(io, `${command} takes no arguments (got "${args[0]}")`, command);
  }
  if (spec.positionals === "one" && args.length > 1) {
    return usageError(io, `${command} takes at most one argument (got ${args.length})`, command);
  }
  if (options.strict === true && options.lenient === true) {
    return usageError(io, "--strict and --lenient cannot be used together", command);
  }
  if (typeof options.port === "string") {
    const port = options.port;
    if (!/^\d+$/.test(port) || Number(port) > 65535) {
      return usageError(
        io,
        `--port must be a whole number from 0 to 65535 (got "${port}")`,
        command,
      );
    }
    options.port = Number(port);
  }

  const context: CommandContext = {
    command,
    args: spec.positionals === "verbatim" ? verbatim : args,
    options: options as CommandOptions,
    cwd: io.cwd,
    env: io.env,
    stdout: io.stdout,
    stderr: io.stderr,
    color: io.color,
    signal: io.signal,
  };
  try {
    const module = await spec.load();
    return await module.run(context);
  } catch (error) {
    return reportFailure(error, io);
  }
}
