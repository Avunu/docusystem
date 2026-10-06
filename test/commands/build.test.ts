import { describe, expect, test, vi } from "vitest";
import { LockError } from "../../src/lib/lock.js";
import type { PipelineDeps } from "../../src/lib/pipeline.js";
import { runCli } from "../support/index.js";
import { distFiles, makeWorld, publishedBefore } from "./support/world.js";

// The pipeline runs for real; the modules of the other work packages are the fakes of support/world.ts.
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

describe("docusystem build", () => {
  test("builds, publishes <site>/dist, prints the manual jx command and exits 0", async () => {
    const world = makeWorld();
    holder.deps = world.deps;
    const { code, stdout, stderr } = await runCli(["build"], { cwd: world.siteDir });
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain(`build: 6 page(s) written to ${world.paths.dist}`);
    expect(stdout).toContain(
      `build: to run Jx by hand on the assembled project: ${process.execPath} /fake/jx/bin/jx.js build ${world.paths.root}`,
    );
    expect(distFiles(world)["index.html"]).toBe("<html>build 1</html>\n");
  });

  test("progress goes to standard output, warnings and errors to standard error", async () => {
    const world = makeWorld();
    world.preflightWarnings = ["slug is not in the catalog"];
    world.lint = [{ file: "a.md", line: 3, level: "warning", rule: "task-list", message: "w" }];
    holder.deps = world.deps;
    const { stdout, stderr } = await runCli(["build"], { cwd: world.dir });
    expect(stderr.split("\n")).toEqual([
      "preflight: warning: slug is not in the catalog",
      "lint: warning: docs/a.md:3  w",
    ]);
    expect(stdout).not.toContain(": warning: ");
  });

  test("--strict, --lenient, CI=true and DOCUSYSTEM_LENIENT=1 decide the strictness", async () => {
    const cases: Array<[string[], NodeJS.ProcessEnv, boolean]> = [
      [[], {}, false],
      [["--strict"], {}, true],
      [[], { CI: "true" }, true],
      [["--lenient"], { CI: "true" }, false],
      [[], { CI: "true", DOCUSYSTEM_LENIENT: "1" }, false],
    ];
    for (const [flags, env, strict] of cases) {
      const world = makeWorld();
      holder.deps = world.deps;
      const { code } = await runCli(["build", ...flags], { cwd: world.dir, env });
      expect(code, `${flags} ${JSON.stringify(env)}`).toBe(0);
      expect(world.seen.assemble[0]?.strict).toBe(strict);
    }
  });

  test("--strict together with --lenient is a usage error", async () => {
    const world = makeWorld();
    holder.deps = world.deps;
    const { code, stderr } = await runCli(["build", "--strict", "--lenient"], { cwd: world.dir });
    expect(code).toBe(2);
    expect(stderr).toContain("--strict and --lenient cannot be used together");
    expect(world.calls).toEqual([]);
  });

  test("--refresh-catalog and --site reach the pipeline", async () => {
    const world = makeWorld();
    const asked: Array<[string | undefined, string]> = [];
    world.deps.findSiteDir = (arg, cwd) => {
      asked.push([arg, cwd]);
      return world.siteDir;
    };
    holder.deps = world.deps;
    const { code } = await runCli(["build", "--refresh-catalog", "--site", "somewhere/docs-site"], {
      cwd: world.dir,
    });
    expect(code).toBe(0);
    expect(asked).toEqual([["somewhere/docs-site", world.dir]]);
    expect(world.seen.assemble[0]?.refreshCatalog).toBe(true);
  });

  test("a failed strict build exits 1, says why, and leaves the previous site alone", async () => {
    const world = makeWorld();
    world.lint = [
      {
        file: "a.md",
        line: 3,
        level: "error",
        rule: "footnote",
        message: "Footnotes are not rendered.",
      },
    ];
    const before = publishedBefore(world);
    holder.deps = world.deps;
    const { code, stderr } = await runCli(["build", "--strict"], { cwd: world.dir });
    expect(code).toBe(1);
    expect(stderr).toContain("lint: error: docs/a.md:3  Footnotes are not rendered.");
    expect(stderr).toContain("1 document problem(s) above fail the build");
    expect(distFiles(world)).toEqual({
      "index.html": before["index.html"],
      "docs/index.html": before["docs/index.html"],
    });
  });

  test("another docusystem process holding the lock is exit 3, naming its pid", async () => {
    const world = makeWorld();
    world.lockError = new LockError(31337);
    holder.deps = world.deps;
    const { code, stderr } = await runCli(["build"], { cwd: world.dir });
    expect(code).toBe(3);
    expect(stderr).toBe("docusystem: another docusystem process (pid 31337) is running");
    expect(world.calls).not.toContain("assemble");
  });

  test("a config problem is exit 1 and nothing is built", async () => {
    const world = makeWorld();
    world.preflightErrors = ["name is required"];
    holder.deps = world.deps;
    const { code, stderr } = await runCli(["build"], { cwd: world.dir });
    expect(code).toBe(1);
    expect(stderr).toBe("preflight: error: name is required");
  });

  test("build takes no --ci: annotations are check's", async () => {
    const world = makeWorld();
    holder.deps = world.deps;
    const { code, stderr } = await runCli(["build", "--ci"], { cwd: world.dir });
    expect(code).toBe(2);
    expect(stderr).toContain("build does not take --ci");
  });
});
