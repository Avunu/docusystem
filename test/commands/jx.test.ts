import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { PipelineDeps } from "../../src/lib/pipeline.js";
import { fixture, runCli } from "../support/index.js";
import { makeWorld, type World } from "./support/world.js";

const holder = vi.hoisted(() => ({ deps: undefined as undefined | PipelineDeps }));
vi.mock("../../src/lib/pipeline.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/lib/pipeline.js")>();
  return {
    ...real,
    defaultDeps: () => holder.deps!,
    runPipeline: (o: Parameters<typeof real.runPipeline>[0]) =>
      real.runPipelineWith(o, holder.deps!),
  };
});

let world: World;
let lockFile: string;
beforeEach(() => {
  world = makeWorld();
  lockFile = join(world.dir, "lock-marker");
  // The Jx of these tests is test/fixtures/fake-jx.mjs: it prints its arguments and exits with $FAKE_JX_EXIT.
  world.deps.jxCli = () => fixture("fake-jx.mjs");
  // A lock that exists as a file for as long as it is held, so that the fake Jx can look for it.
  world.deps.acquireLock = () => {
    world.calls.push("lock");
    writeFileSync(lockFile, "held");
    return () => {
      rmSync(lockFile, { force: true });
      world.calls.push("unlock");
    };
  };
  holder.deps = world.deps;
});

const jx = (argv: string[], env: NodeJS.ProcessEnv = {}) =>
  runCli(["jx", ...argv], { cwd: world.dir, env: { ...env, FAKE_LOCK_FILE: lockFile } });

describe("docusystem jx", () => {
  test("assembles the root, then runs Jx as `jx <arguments> <root>` in it", async () => {
    const { code, stdout } = await jx(["validate"]);
    expect(code).toBe(0);
    expect(world.calls).toEqual([
      "findSiteDir",
      "preflight",
      "lock",
      "assemble",
      "stage",
      "lint",
      "nav",
      "unlock",
    ]);
    expect(world.calls).not.toContain("jx"); // the pipeline's own Jx run (a build) never happens
    const printed = JSON.parse(stdout) as { args: string[]; cwd: string };
    expect(printed.args).toEqual(["validate", world.paths.root]);
    expect(printed.cwd).toBe(world.paths.root);
  });

  test("everything after the word jx goes to Jx unchanged, flags included", async () => {
    const { stdout } = await jx(["build", "--verbose", "--no-clean", "--strict"]);
    const printed = JSON.parse(stdout) as { args: string[] };
    expect(printed.args).toEqual([
      "build",
      "--verbose",
      "--no-clean",
      "--strict",
      world.paths.root,
    ]);
  });

  test("--site before the word jx is docusystem's", async () => {
    const asked: Array<string | undefined> = [];
    world.deps.findSiteDir = (arg) => {
      asked.push(arg);
      return world.siteDir;
    };
    const { code } = await runCli(["--site", "x/docs-site", "jx", "validate"], {
      cwd: world.dir,
      env: { FAKE_LOCK_FILE: lockFile },
    });
    expect(code).toBe(0);
    expect(asked).toEqual(["x/docs-site"]);
  });

  test("standard output is Jx's alone: the assembly's progress is on standard error", async () => {
    const { stdout, stderr } = await jx(["validate"]);
    expect(stdout.split("\n")).toHaveLength(1);
    expect(stdout.startsWith("{")).toBe(true);
    expect(stderr).toContain("assemble: 5 file(s)");
    expect(stderr).toContain("nav: 4 page(s)");
    expect(stderr).toContain("fake jx: a line on standard error");
  });

  test("the lock is held while Jx runs and released after", async () => {
    const { stdout } = await jx(["validate"]);
    expect((JSON.parse(stdout) as { locked: boolean }).locked).toBe(true);
    expect(existsSync(lockFile)).toBe(false);
    expect(world.calls.at(-1)).toBe("unlock");
  });

  test("the exit code is Jx's", async () => {
    expect((await jx(["validate"], { FAKE_JX_EXIT: "1" })).code).toBe(1);
    expect((await jx(["validate"], { FAKE_JX_EXIT: "9" })).code).toBe(9);
  });

  test("when the root cannot be assembled Jx is not run and the exit code is 1", async () => {
    world.assemblyErrors = ["overrides/components/sub/x.json: components must be flat"];
    const { code, stdout, stderr } = await jx(["validate"]);
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("components must be flat");
  });

  test("lint errors do not stop it: this is a debugging aid", async () => {
    world.lint = [
      {
        file: "a.md",
        line: 1,
        level: "error",
        rule: "footnote",
        message: "Footnotes are not rendered.",
      },
    ];
    const { code, stderr } = await jx(["validate"], { CI: "true" });
    expect(code).toBe(0);
    expect(stderr).toContain("lint: error: docs/a.md:1  Footnotes are not rendered.");
  });

  test("without a Jx command it is a usage error", async () => {
    const { code, stderr } = await jx([]);
    expect(code).toBe(2);
    expect(stderr).toContain("jx needs the Jx command to run");
    expect(world.calls).toEqual([]);
  });

  test("`jx dev` is refused and points at docusystem dev", async () => {
    const { code, stderr } = await jx(["dev"]);
    expect(code).toBe(2);
    expect(stderr).toContain("`jx dev` is not supported");
    expect(stderr).toContain("docusystem dev");
    expect(world.calls).toEqual([]);
  });

  test("strict links follow CI=true, as in a build", async () => {
    await jx(["validate"], { CI: "true" });
    expect(world.seen.assemble[0]?.strict).toBe(true);
    await jx(["validate"]);
    expect(world.seen.assemble[1]?.strict).toBe(false);
  });
});
