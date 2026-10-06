import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { PipelineDeps } from "../../src/lib/pipeline.js";
import type { Failure, LinkReport } from "../../src/lib/types.js";
import { runCli, tempDir } from "../support/index.js";
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

// The modules of WP4 are replaced by controllable fakes: this file tests what `check` does with their
// answers (the real ones are exercised by test/integration after the merge).
const wp4 = vi.hoisted(() => ({
  contrastFailures: vi.fn(),
  highlightOf: vi.fn(),
  checkLinks: vi.fn(),
}));
vi.mock("../../src/lib/contrast.js", () => ({
  contrastFailures: wp4.contrastFailures,
  highlightOf: wp4.highlightOf,
}));
vi.mock("../../src/lib/links.js", () => ({
  checkLinks: wp4.checkLinks,
  formatIssues: (issues: Array<{ page: string; message: string }>) =>
    issues.map((issue) => `${issue.page}  ${issue.message}`).join("\n"),
}));

const HIGHLIGHT = { token: "--color-action", percent: 22, text: ["--color-text"] };
const report = (over: Partial<LinkReport> = {}): LinkReport => ({
  pages: 6,
  checked: 889,
  errors: [],
  warnings: [],
  ...over,
});

let world: World;
beforeEach(() => {
  world = makeWorld();
  holder.deps = world.deps;
  wp4.contrastFailures.mockReset().mockReturnValue({ checked: 148, failures: [] });
  wp4.highlightOf.mockReset().mockReturnValue(HIGHLIGHT);
  wp4.checkLinks.mockReset().mockReturnValue(report());
});

const check = (flags: string[] = [], env: NodeJS.ProcessEnv = {}) =>
  runCli(["check", ...flags], { cwd: world.siteDir, env });

describe("docusystem check", () => {
  test("a strict build, the contrast gate and the crawl, then the verdict", async () => {
    const { code, stdout, stderr } = await check();
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(world.seen.assemble[0]?.strict).toBe(true);
    const lines = stdout.split("\n");
    expect(lines).toContain("contrast: 148 color pair(s) checked, 0 below the minimum");
    expect(lines).toContain("links: 6 page(s), 889 reference(s) checked");
    expect(lines.at(-1)).toBe("check: all steps passed");
    // the order of 5.1: the build's output, then contrast, then links
    const at = (text: string): number => lines.findIndex((line) => line.startsWith(text));
    expect(at("build: 6 page(s) written")).toBeLessThan(at("contrast:"));
    expect(at("contrast:")).toBeLessThan(at("links:"));
  });

  test("reads the effective tokens and the search highlight from the assembled root", async () => {
    await check();
    expect(wp4.contrastFailures).toHaveBeenCalledWith({ "--color-text": "#000000" }, HIGHLIGHT);
    expect(wp4.highlightOf).toHaveBeenCalledWith({
      backgroundColor: "color-mix(in srgb, var(--color-action) 22%, transparent)",
    });
    expect(wp4.checkLinks).toHaveBeenCalledOnce();
    const [dist, options] = wp4.checkLinks.mock.calls[0] as [
      string,
      { nav: { home: { url: string } } },
    ];
    expect(dist).toBe(world.paths.dist);
    expect(options.nav.home.url).toBe("/docs/");
  });

  test("is always strict: CI is not needed, DOCUSYSTEM_LENIENT is ignored, --lenient is a usage error", async () => {
    await check([], { DOCUSYSTEM_LENIENT: "1" });
    expect(world.seen.assemble[0]?.strict).toBe(true);
    expect(world.seen.assemble[0]?.env?.DOCUSYSTEM_LENIENT).toBeUndefined();

    const refused = await check(["--lenient"]);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain("check does not take --lenient");
  });

  test("a document problem fails it: exit 1, the contrast gate still ran, the crawl did not", async () => {
    world.lint = [
      {
        file: "a.md",
        line: 3,
        level: "error",
        rule: "footnote",
        message: "Footnotes are not rendered.",
      },
    ];
    const { code, stdout, stderr } = await check();
    expect(code).toBe(1);
    expect(stderr).toContain("lint: error: docs/a.md:3  Footnotes are not rendered.");
    expect(wp4.contrastFailures).toHaveBeenCalledOnce();
    expect(wp4.checkLinks).not.toHaveBeenCalled();
    expect(stdout.split("\n").at(-1)).toBe("check: FAILED");
  });

  test("a preflight error stops everything: no contrast, no crawl", async () => {
    world.preflightErrors = ["name is required"];
    const { code, stdout } = await check();
    expect(code).toBe(1);
    expect(wp4.contrastFailures).not.toHaveBeenCalled();
    expect(wp4.checkLinks).not.toHaveBeenCalled();
    expect(stdout).toBe("check: FAILED");
  });

  test("a root that could not be assembled has no tokens: the gate does not run on a stale one", async () => {
    world.assemblyErrors = ["overrides: overrides/components/sub/x.json is nested"];
    const { code, stderr } = await check();
    expect(code).toBe(1);
    expect(stderr).toContain("overrides: overrides/components/sub/x.json is nested");
    expect(stderr).not.toContain("contrast:");
    expect(wp4.contrastFailures).not.toHaveBeenCalled();
  });

  test("a color pair below its minimum fails the check and is named", async () => {
    const failure: Failure = { theme: "light", label: "action on page", ratio: 1.78, minimum: 4.5 };
    wp4.contrastFailures.mockReturnValue({ checked: 148, failures: [failure] });
    const { code, stdout, stderr } = await check();
    expect(code).toBe(1);
    expect(stdout).toContain("contrast: 148 color pair(s) checked, 1 below the minimum");
    expect(stderr).toBe("contrast: error: light: action on page is 1.78:1, needs 4.5:1");
    expect(wp4.checkLinks).toHaveBeenCalledOnce(); // the crawl still runs: a red run shows everything at once
    expect(stdout.split("\n").at(-1)).toBe("check: FAILED");
  });

  test("a broken link fails the check, one line per issue", async () => {
    wp4.checkLinks.mockReturnValue(
      report({
        errors: [
          { page: "/docs/a/", message: 'link to "/docs/missing/" does not resolve' },
          { page: "/docs/b/", message: 'anchor "#nope" does not exist' },
        ],
        warnings: [{ page: "/docs/c/", message: "external link not checked" }],
      }),
    );
    const { code, stderr } = await check();
    expect(code).toBe(1);
    expect(stderr.split("\n")).toEqual([
      "links: warning: /docs/c/  external link not checked",
      'links: error: /docs/a/  link to "/docs/missing/" does not resolve',
      'links: error: /docs/b/  anchor "#nope" does not exist',
    ]);
  });

  test("a bug in the gate (an exception) is not swallowed: it reaches main.ts", async () => {
    wp4.contrastFailures.mockImplementation(() => {
      throw new Error("boom");
    });
    const { code, stderr } = await check();
    expect(code).toBe(1);
    expect(stderr).toContain("docusystem: boom");
  });

  test("a project.json that cannot be read is a failure of the gate, reported as such", async () => {
    const original = world.deps.replaceDir;
    world.deps.replaceDir = (from, to) => {
      writeFileSync(join(world.paths.root, "project.json"), "{ not json");
      original(from, to);
    };
    const { code, stderr } = await check();
    expect(code).toBe(1);
    expect(stderr).toContain("contrast: error: cannot read the resolved design tokens:");
  });

  test("a shell without the search component has no highlight to check", async () => {
    const original = world.deps.assemble;
    world.deps.assemble = async (args) => {
      const assembly = await original(args);
      const { rmSync } = await import("node:fs");
      rmSync(join(world.paths.root, "components", "docs-search.json"));
      return assembly;
    };
    wp4.highlightOf.mockReturnValue(null);
    const { code } = await check();
    expect(code).toBe(0);
    expect(wp4.highlightOf).toHaveBeenCalledWith(undefined);
  });
});

describe("docusystem check --ci", () => {
  const files = () => {
    const dir = tempDir();
    return { summary: join(dir, "summary.md"), output: join(dir, "output") };
  };

  test("writes the job summary and the step outputs of a passing run", async () => {
    const { summary, output } = files();
    const { code, stdout } = await check(["--ci"], {
      GITHUB_STEP_SUMMARY: summary,
      GITHUB_OUTPUT: output,
    });
    expect(code).toBe(0);
    expect(stdout.split("\n").some((line) => line.startsWith("::"))).toBe(false);
    expect(readFileSync(output, "utf8")).toBe(
      `dist=${world.paths.dist}\npage-url=https://example.avunu.net/\npages=6\n`,
    );
    const markdown = readFileSync(summary, "utf8");
    expect(markdown).toContain("### Documentation check: passed");
    expect(markdown).toContain("| Build | ok: 6 page(s) written |");
    expect(markdown).toContain("| Contrast | ok: 148 color pair(s), 0 below the minimum |");
    expect(markdown).toContain(
      "| Links | ok: 6 page(s), 889 reference(s), 0 error(s), 0 warning(s) |",
    );
    expect(markdown).toContain("- @avunu/docusystem 0.1.0, node 24.0.0");
    expect(markdown).toContain("- @jxsuite/compiler 5.0.0");
    expect(markdown).toContain("- project catalog: bundled");
    expect(markdown).toContain("- overrides: none");
  });

  test("GITHUB_ACTIONS=true implies --ci", async () => {
    const { summary, output } = files();
    await check([], {
      GITHUB_ACTIONS: "true",
      GITHUB_STEP_SUMMARY: summary,
      GITHUB_OUTPUT: output,
    });
    expect(readFileSync(summary, "utf8")).toContain("passed");
    expect(readFileSync(output, "utf8")).toContain("pages=6");
  });

  test("without --ci nothing is written even when the files are named", async () => {
    const { summary, output } = files();
    await check([], { GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: output });
    expect(() => readFileSync(summary)).toThrow();
    expect(() => readFileSync(output)).toThrow();
  });

  test("a failed run has the summary with the problems and the essentials, and no outputs", async () => {
    const { summary, output } = files();
    world.lint = [
      {
        file: "guide/x.md",
        line: 15,
        level: "error",
        rule: "footnote",
        message: "Footnotes are not rendered.",
      },
    ];
    world.shadowed = ["components/docs-footer.json"];
    const { code } = await check(["--ci"], { GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: output });
    expect(code).toBe(1);
    expect(() => readFileSync(output)).toThrow();
    const markdown = readFileSync(summary, "utf8");
    expect(markdown).toContain("### Documentation check: failed");
    expect(markdown).toContain("| Build | FAILED: 1 error(s), nothing was published |");
    expect(markdown).toContain("error: docs/guide/x.md:15  Footnotes are not rendered.");
    expect(markdown).toContain(
      "- overrides: components/docs-footer.json (replaces the package's file)",
    );
    expect(markdown).toContain("- @jxsuite/compiler 5.0.0");
  });

  test("a preflight failure still has a summary, from what this process knows", async () => {
    const { summary } = files();
    world.preflightErrors = ["name is required"];
    await check(["--ci"], { GITHUB_STEP_SUMMARY: summary });
    const markdown = readFileSync(summary, "utf8");
    expect(markdown).toContain("failed");
    expect(markdown).toMatch(/- @avunu\/docusystem \d+\.\d+\.\d+(-[\w.]+)?, (node|bun) \d/);
  });

  test("annotations (byte for byte): the build's, the contrast gate's and the crawl's", async () => {
    world.lint = [
      {
        file: "guide/x.md",
        line: 15,
        level: "error",
        rule: "footnote",
        message: "Footnotes are not rendered.",
      },
    ];
    wp4.contrastFailures.mockReturnValue({
      checked: 148,
      failures: [{ theme: "dark", label: "action on page", ratio: 2.5, minimum: 4.5 }],
    });
    const failing = await check(["--ci"]);
    expect(failing.stdout.split("\n").filter((line) => line.startsWith("::"))).toEqual([
      "::error file=docs/guide/x.md,line=15,title=lint::Footnotes are not rendered.",
      "::error title=contrast::dark: action on page is 2.5:1, needs 4.5:1",
    ]);

    world.lint = [];
    wp4.contrastFailures.mockReturnValue({ checked: 148, failures: [] });
    wp4.checkLinks.mockReturnValue(
      report({
        errors: [{ page: "/docs/a/", message: 'link to "/docs/missing/" does not resolve' }],
      }),
    );
    const crawl = await check(["--ci"]);
    expect(crawl.stdout.split("\n").filter((line) => line.startsWith("::"))).toEqual([
      '::error title=links::/docs/a/  link to "/docs/missing/" does not resolve',
    ]);
  });
});
