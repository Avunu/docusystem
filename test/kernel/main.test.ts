import { describe, expect, test, vi } from "vitest";
import type { CommandContext } from "../../src/commands/types.js";
import { LockError } from "../../src/lib/lock.js";
import { NODE_FLOOR, WORKFLOW_CONTRACT, version } from "../../src/lib/package-info.js";
import {
  atLeast,
  commandHelp,
  environmentProblem,
  helpText,
  type RunEnvironment,
} from "../../src/main.js";
import { runCli } from "../support/index.js";

// Every command module is replaced by one that hands its context to `hooks.handler`, so that these
// tests check what main.ts decides (parsing, the gate, dispatch, exit codes) and not what any command
// does: the commands belong to other work packages and are stubs when this file is written.
const { hooks, delegate } = vi.hoisted(() => {
  const state = {
    handler: undefined as undefined | ((ctx: CommandContext) => Promise<number>),
  };
  return {
    hooks: state,
    delegate: () => ({
      run: (ctx: CommandContext) => (state.handler ?? (async () => 0))(ctx),
    }),
  };
});
vi.mock("../../src/commands/init.js", delegate);
vi.mock("../../src/commands/build.js", delegate);
vi.mock("../../src/commands/check.js", delegate);
vi.mock("../../src/commands/dev.js", delegate);
vi.mock("../../src/commands/lint.js", delegate);
vi.mock("../../src/commands/links.js", delegate);
vi.mock("../../src/commands/info.js", delegate);
vi.mock("../../src/commands/doctor.js", delegate);
vi.mock("../../src/commands/upgrade.js", delegate);
vi.mock("../../src/commands/eject.js", delegate);
vi.mock("../../src/commands/jx.js", delegate);

const COMMANDS = [
  "init",
  "build",
  "check",
  "dev",
  "lint",
  "links",
  "info",
  "doctor",
  "upgrade",
  "eject",
  "jx",
];

/** Runs `argv` and returns what the command received (undefined when no command ran) and the result. */
async function dispatch(argv: string[], overrides: Partial<RunEnvironment> = {}) {
  let seen: CommandContext | undefined;
  hooks.handler = async (ctx) => {
    seen = ctx;
    return 0;
  };
  const result = await runCli(argv, overrides);
  hooks.handler = undefined;
  return { ctx: seen, ...result };
}

describe("--version and --help", () => {
  test("--version and -v print the version and exit 0", async () => {
    for (const flag of ["--version", "-v"]) {
      expect(await runCli([flag])).toEqual({ code: 0, stdout: version, stderr: "" });
    }
  });

  test("--help, -h and no command print the help and exit 0", async () => {
    for (const argv of [["--help"], ["-h"], []]) {
      const { code, stdout, stderr } = await runCli(argv);
      expect(code).toBe(0);
      expect(stderr).toBe("");
      expect(stdout).toBe(helpText().trimEnd());
    }
  });

  test("the help lists the eleven commands, in order, and the exit codes", async () => {
    const { stdout } = await runCli(["--help"]);
    const listed = [...stdout.matchAll(/^ {2}([a-z]+) {2,}\S/gm)].map((m) => m[1]);
    expect(listed).toEqual(COMMANDS);
    expect(stdout).toContain("Exit codes: 0 ok; 1 problems found; 2 usage error; 3 environment");
    expect(stdout).toContain("--site <dir>");
    expect(stdout).toContain("--version");
  });

  test("--version wins over everything else on the line", async () => {
    expect((await runCli(["build", "--help", "--version"])).stdout).toBe(version);
  });

  test("a command with --help prints that command's usage and options and runs nothing", async () => {
    for (const command of COMMANDS) {
      // After `jx` everything is Jx's, so its --help goes before it.
      const argv = command === "jx" ? ["--help", command] : [command, "--help"];
      const { ctx, code, stdout } = await dispatch(argv);
      expect(ctx).toBeUndefined();
      expect(code).toBe(0);
      expect(stdout).toBe(commandHelp(command as never).trimEnd());
      expect(stdout).toMatch(new RegExp(`^Usage: docusystem ${command}\\b`));
    }
    expect((await runCli(["--help", "build"])).stdout).toContain("--refresh-catalog");
    expect((await runCli(["build", "-h"])).stdout).toContain("--strict");
  });

  test("the usage of jx --help is Jx's: it goes to Jx", async () => {
    const { ctx } = await dispatch(["jx", "--help"]);
    expect(ctx?.args).toEqual(["--help"]);
  });
});

describe("usage errors exit 2, with the message and the help on standard error", () => {
  test("an unknown command", async () => {
    const { code, stdout, stderr } = await runCli(["frobnicate"]);
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain('docusystem: unknown command "frobnicate"');
    expect(stderr).toContain("Usage: docusystem <command>");
    for (const command of COMMANDS) expect(stderr).toContain(command);
  });

  test("names that are properties of every object are still unknown commands", async () => {
    for (const word of ["constructor", "toString", "__proto__", "hasOwnProperty", "help"]) {
      expect((await runCli([word])).code, word).toBe(2);
    }
  });

  test("an unknown option, before or after the command", async () => {
    for (const argv of [["--frobnicate"], ["build", "--frobnicate"], ["--frobnicate", "build"]]) {
      const { code, stderr } = await runCli(argv);
      expect(code, argv.join(" ")).toBe(2);
      expect(stderr).toContain("docusystem: Unknown option '--frobnicate'");
      expect(stderr).not.toContain("To specify a positional argument");
      expect(stderr).toContain("Usage: docusystem <command>");
    }
  });

  test("an option without its value", async () => {
    const { code, stderr } = await runCli(["build", "--site"]);
    expect(code).toBe(2);
    expect(stderr).toContain("--site");
  });

  test("an option that another command takes", async () => {
    const cases: Array<[string[], string]> = [
      [["build", "--port", "3000"], "build does not take --port"],
      [["check", "--lenient"], "check does not take --lenient"],
      [["check", "--strict"], "check does not take --strict"],
      [["dev", "--strict"], "dev does not take --strict"],
      [["lint", "--json"], "lint does not take --json"],
      [["links", "--ci"], "links does not take --ci"],
      [["info", "--force"], "info does not take --force"],
      [["doctor", "--nav"], "doctor does not take --nav"],
      [["upgrade", "--force"], "upgrade does not take --force"],
      [["eject", "--dry-run"], "eject does not take --dry-run"],
    ];
    for (const [argv, message] of cases) {
      const { ctx, code, stderr } = await dispatch(argv);
      expect(ctx, argv.join(" ")).toBeUndefined();
      expect(code, argv.join(" ")).toBe(2);
      expect(stderr).toContain(`docusystem: ${message}`);
      expect(stderr).toContain(`Usage: docusystem ${argv[0]}`);
    }
  });

  test("init takes --site-dir, not the global --site", async () => {
    const { code, stderr } = await runCli(["init", "--site", "docs-site"]);
    expect(code).toBe(2);
    expect(stderr).toContain("init does not take --site");
    expect(stderr).toContain("--site-dir");
  });

  test("--strict together with --lenient", async () => {
    const { ctx, code, stderr } = await dispatch(["build", "--strict", "--lenient"]);
    expect(ctx).toBeUndefined();
    expect(code).toBe(2);
    expect(stderr).toContain("--strict and --lenient cannot be used together");
  });

  test("arguments for a command that takes none, or too many", async () => {
    for (const argv of [
      ["build", "x"],
      ["lint", "x"],
      ["init", "x"],
      ["links", "a", "b"],
    ]) {
      const { ctx, code } = await dispatch(argv);
      expect(ctx, argv.join(" ")).toBeUndefined();
      expect(code, argv.join(" ")).toBe(2);
    }
  });

  test("--port must be a whole number from 0 to 65535", async () => {
    for (const port of ["abc", "-1", "1.5", "65536", "", "3000x", "1e3"]) {
      const { ctx, code, stderr } = await dispatch(["dev", `--port=${port}`]);
      expect(ctx, port).toBeUndefined();
      expect(code, port).toBe(2);
      expect(stderr).toContain("--port must be a whole number from 0 to 65535");
    }
    for (const [text, number] of [
      ["0", 0],
      ["3000", 3000],
      ["65535", 65535],
    ] as const) {
      expect((await dispatch(["dev", "--port", text])).ctx?.options.port).toBe(number);
    }
  });
});

describe("the environment gate runs before anything else (exit 3)", () => {
  test("a workflow contract that is not this package's names the `uses:` line to change", async () => {
    const { code, stdout, stderr } = await runCli(["check", "--ci"], {
      env: { DOCUSYSTEM_WORKFLOW_CONTRACT: String(WORKFLOW_CONTRACT + 1) },
    });
    expect(code).toBe(3);
    expect(stdout).toBe("");
    expect(stderr).toMatch(/^docusystem: /);
    expect(stderr).toContain(`contract ${WORKFLOW_CONTRACT + 1}`);
    expect(stderr).toContain(`implements contract ${WORKFLOW_CONTRACT}`);
    expect(stderr).toContain("uses: Avunu/docusystem/.github/workflows/docs-build.yml@<commit>");
    expect(stderr).toContain(".github/workflows/docs.yml");
    expect(stderr).toContain(`v${version}`);
    expect(stderr).toContain("docusystem upgrade");
  });

  test("DOCUSYSTEM_WORKFLOW_CONTRACT=2 exits 3 now, whichever command or flag is on the line", async () => {
    const env = { DOCUSYSTEM_WORKFLOW_CONTRACT: "2" };
    for (const argv of [["--version"], ["--help"], [], ["build"], ["frobnicate"], ["--frob"]]) {
      expect((await runCli(argv, { env })).code, argv.join(" ")).toBe(3);
    }
  });

  test("the contract of this package, an empty one and an absent one pass", async () => {
    for (const env of [
      { DOCUSYSTEM_WORKFLOW_CONTRACT: String(WORKFLOW_CONTRACT) },
      { DOCUSYSTEM_WORKFLOW_CONTRACT: "" },
      {},
    ]) {
      expect((await runCli(["--version"], { env })).code).toBe(0);
    }
  });

  test("Node older than the floor exits 3, with the version it found and the floor", async () => {
    for (const nodeVersion of [
      "20.11.0",
      "22.18.9",
      "22.0.0",
      "18.20.4",
      "21.99.99",
      "garbage",
      "",
    ]) {
      const { code, stdout, stderr } = await runCli(["--version"], { nodeVersion });
      expect(code, nodeVersion).toBe(3);
      expect(stdout).toBe("");
      expect(stderr).toContain(`Node ${nodeVersion} is too old`);
      expect(stderr).toContain(`needs Node ${NODE_FLOOR} or newer`);
    }
    for (const nodeVersion of [NODE_FLOOR, "22.19.1", "22.20.0", "23.0.0", "24.21.0", "v26.10.0"]) {
      expect((await runCli(["--version"], { nodeVersion })).code, nodeVersion).toBe(0);
    }
  });

  test("the Node floor is checked before the contract", () => {
    const problem = environmentProblem({
      nodeVersion: "20.0.0",
      env: { DOCUSYSTEM_WORKFLOW_CONTRACT: "99" },
    });
    expect(problem).toContain("too old");
    expect(problem).not.toContain("contract");
  });

  test("atLeast compares numerically, not as text", () => {
    expect(atLeast("22.19.0", "22.19.0")).toBe(true);
    expect(atLeast("22.9.0", "22.19.0")).toBe(false);
    expect(atLeast("22.100.0", "22.19.0")).toBe(true);
    expect(atLeast("100.0.0", "22.19.0")).toBe(true);
    expect(atLeast("22.19.0-pre", "22.19.0")).toBe(true);
    expect(atLeast("9.99.99", "22.19.0")).toBe(false);
  });

  test("a command that runs finds the gate has passed", async () => {
    const { ctx } = await dispatch(["build"], { nodeVersion: NODE_FLOOR, env: {} });
    expect(ctx?.command).toBe("build");
  });
});

describe("dispatch", () => {
  test("each command runs its own module with a complete context", async () => {
    const stdout = vi.fn();
    const stderr = vi.fn();
    const signal = new AbortController().signal;
    const env = { CI: "true", NO_COLOR: "1" };
    for (const command of COMMANDS) {
      const { ctx, code } = await dispatch([command], {
        cwd: "/work/repo",
        env,
        stdout,
        stderr,
        color: true,
        signal,
      });
      expect(code, command).toBe(0);
      expect(ctx).toEqual({
        command,
        args: [],
        options: {},
        cwd: "/work/repo",
        env,
        stdout,
        stderr,
        color: true,
        signal,
      });
    }
  });

  test("the exit code of the command is the exit code of the process", async () => {
    for (const code of [0, 1, 2, 3, 7]) {
      hooks.handler = async () => code;
      expect((await runCli(["build"])).code).toBe(code);
    }
    hooks.handler = undefined;
  });

  test("global --site goes to every command but init", async () => {
    for (const command of COMMANDS.filter((c) => c !== "init" && c !== "jx")) {
      const { ctx } = await dispatch([command, "--site", "docs-site"]);
      expect(ctx?.options.site, command).toBe("docs-site");
    }
    expect((await dispatch(["--site=docs-site", "info"])).ctx?.options.site).toBe("docs-site");
  });

  test("the options of init become camelCase keys", async () => {
    const { ctx, code } = await dispatch([
      "init",
      "--site-dir",
      "website",
      "--name",
      "Example",
      "--tagline",
      "A tagline.",
      "--slug",
      "example",
      "--platform",
      "nixos",
      "--repo",
      "https://github.com/Avunu/example",
      "--domain",
      "example.avunu.net",
      "--license",
      "MIT",
      "--branch",
      "develop",
      "--docs",
      "../handbook",
      "--from-readme",
      "--no-workflow",
      "--no-dependabot",
      "--no-patch-automerge",
      "--workflow-sha",
      "0123456789abcdef0123456789abcdef01234567",
      "--force",
      "--dry-run",
    ]);
    expect(code).toBe(0);
    expect(ctx?.options).toEqual({
      siteDir: "website",
      name: "Example",
      tagline: "A tagline.",
      slug: "example",
      platform: "nixos",
      repo: "https://github.com/Avunu/example",
      domain: "example.avunu.net",
      license: "MIT",
      branch: "develop",
      docs: "../handbook",
      fromReadme: true,
      noWorkflow: true,
      noDependabot: true,
      noPatchAutomerge: true,
      workflowSha: "0123456789abcdef0123456789abcdef01234567",
      force: true,
      dryRun: true,
    });
  });

  test("the options of the other commands", async () => {
    const cases: Array<[string[], object]> = [
      [["build", "--strict", "--refresh-catalog"], { strict: true, refreshCatalog: true }],
      [["build", "--lenient"], { lenient: true }],
      [["check", "--ci", "--refresh-catalog"], { ci: true, refreshCatalog: true }],
      [["dev", "--port", "4000"], { port: 4000 }],
      [["info", "--json", "--nav"], { json: true, nav: true }],
      [["doctor", "--json"], { json: true }],
      [["upgrade", "--dry-run", "--workflow-sha", "abc"], { dryRun: true, workflowSha: "abc" }],
      [["eject", "--all", "--force"], { all: true, force: true }],
    ];
    for (const [argv, options] of cases) {
      expect((await dispatch(argv)).ctx?.options, argv.join(" ")).toEqual(options);
    }
  });

  test("positional arguments: the dist of links, the files of eject", async () => {
    expect((await dispatch(["links"])).ctx?.args).toEqual([]);
    expect((await dispatch(["links", "out/dist"])).ctx?.args).toEqual(["out/dist"]);
    expect(
      (await dispatch(["eject", "components/docs-footer.json", "pages/index.json"])).ctx?.args,
    ).toEqual(["components/docs-footer.json", "pages/index.json"]);
    expect((await dispatch(["eject", "--force", "layouts/base.json"])).ctx).toMatchObject({
      args: ["layouts/base.json"],
      options: { force: true },
    });
  });

  test("jx passes everything after it to Jx, verbatim; --site goes before it", async () => {
    const { ctx } = await dispatch([
      "--site",
      "docs-site",
      "jx",
      "validate",
      "--site",
      "x",
      "-v",
      "--",
      "y",
    ]);
    expect(ctx?.command).toBe("jx");
    expect(ctx?.args).toEqual(["validate", "--site", "x", "-v", "--", "y"]);
    expect(ctx?.options).toEqual({ site: "docs-site" });
    expect((await dispatch(["jx"])).ctx?.args).toEqual([]);
    // an option of ours before `jx` that jx does not take is still an error
    expect((await dispatch(["--port", "1", "jx", "validate"])).code).toBe(2);
    // a value that happens to be the word jx is a value, not the command
    const site = await dispatch(["--site", "jx", "build"]);
    expect(site.ctx?.command).toBe("build");
    expect(site.ctx?.options.site).toBe("jx");
  });
});

describe("failures of a command", () => {
  test("a thrown error is printed once, as `docusystem: <message>`, and exits 1", async () => {
    hooks.handler = async () => {
      throw new Error("the configuration is not valid");
    };
    const { code, stdout, stderr } = await runCli(["build"]);
    hooks.handler = undefined;
    expect({ code, stdout, stderr }).toEqual({
      code: 1,
      stdout: "",
      stderr: "docusystem: the configuration is not valid",
    });
  });

  test("something that is not an Error is printed too", async () => {
    hooks.handler = async () => {
      throw "just a string";
    };
    const { code, stderr } = await runCli(["build"]);
    hooks.handler = undefined;
    expect(code).toBe(1);
    expect(stderr).toBe("docusystem: just a string");
  });

  test("another process holding the lock is an environment problem: exit 3, naming the pid", async () => {
    hooks.handler = async () => {
      // Built without the constructor, whose parameters belong to the lock module.
      throw Object.assign(Object.create(LockError.prototype) as LockError, {
        message: "another docusystem process (pid 4242) is building this site",
        pid: 4242,
      });
    };
    const { code, stderr } = await runCli(["check"]);
    hooks.handler = undefined;
    expect(code).toBe(3);
    expect(stderr).toBe("docusystem: another docusystem process (pid 4242) is building this site");
  });

  test("a programming error is reported as a bug, with its stack, and exits 1", async () => {
    hooks.handler = async () => {
      (undefined as unknown as { x: () => void }).x();
      return 0;
    };
    const { code, stderr } = await runCli(["build"]);
    hooks.handler = undefined;
    expect(code).toBe(1);
    expect(stderr).toContain("docusystem: internal error: TypeError");
    expect(stderr).toContain("main.test.ts");
    expect(stderr).toContain("https://github.com/Avunu/docusystem/issues");
  });
});
