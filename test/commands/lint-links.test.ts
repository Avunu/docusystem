import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { ConfigError } from "../../src/lib/config.js";
import type { LinkReport, LintIssue } from "../../src/lib/types.js";
import { runCli } from "../support/index.js";
import { makeWorld, type World } from "./support/world.js";

// WP1 (config), WP3 (lint) and WP4 (links) are fakes here; the real ones run in test/integration.
const fakes = vi.hoisted(() => ({
  findSiteDir: vi.fn(),
  readConfig: vi.fn(),
  pathsFor: vi.fn(),
  lintDocs: vi.fn(),
  checkLinks: vi.fn(),
}));
vi.mock("../../src/lib/config.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/lib/config.js")>();
  return {
    ...real,
    findSiteDir: fakes.findSiteDir,
    readConfig: fakes.readConfig,
    pathsFor: fakes.pathsFor,
  };
});
vi.mock("../../src/lib/lint.js", () => ({
  lintDocs: fakes.lintDocs,
  formatIssue: (issue: LintIssue) => `docs/${issue.file}:${issue.line}  ${issue.message}`,
}));
vi.mock("../../src/lib/links.js", () => ({
  checkLinks: fakes.checkLinks,
  formatIssues: (issues: Array<{ page: string; message: string }>) =>
    issues.map((issue) => `${issue.page}  ${issue.message}`).join("\n"),
}));

let world: World;
beforeEach(() => {
  world = makeWorld();
  for (const fake of Object.values(fakes)) fake.mockReset();
  fakes.findSiteDir.mockReturnValue(world.siteDir);
  fakes.readConfig.mockReturnValue(world.config);
  fakes.pathsFor.mockReturnValue(world.paths);
});

const issue = (over: Partial<LintIssue>): LintIssue => ({
  file: "a.md",
  line: 1,
  level: "error",
  rule: "rule",
  message: "message",
  ...over,
});

describe("docusystem lint", () => {
  test("prints level: file:line message, a summary, and exits 1 on an error", async () => {
    fakes.lintDocs.mockReturnValue([
      issue({ file: "README.md", line: 14, message: "Reference-style links are not rendered." }),
      issue({
        file: "guide/x.md",
        line: 8,
        level: "warning",
        message: "Task-list checkboxes are shown as plain list items.",
      }),
    ]);
    const { code, stdout, stderr } = await runCli(["lint"], { cwd: world.dir });
    expect(code).toBe(1);
    expect(stderr).toBe("");
    expect(stdout.split("\n")).toEqual([
      "error: docs/README.md:14  Reference-style links are not rendered.",
      "warning: docs/guide/x.md:8  Task-list checkboxes are shown as plain list items.",
      "lint: 1 error(s), 1 warning(s)",
    ]);
  });

  test("warnings alone are exit 0, and a clean tree says so", async () => {
    fakes.lintDocs.mockReturnValue([issue({ level: "warning" })]);
    expect((await runCli(["lint"], { cwd: world.dir })).code).toBe(0);
    fakes.lintDocs.mockReturnValue([]);
    const clean = await runCli(["lint"], { cwd: world.dir });
    expect(clean).toEqual({ code: 0, stdout: "lint: 0 error(s), 0 warning(s)", stderr: "" });
  });

  test("lints the Markdown folder of the site, inside its repository, and builds nothing", async () => {
    fakes.lintDocs.mockReturnValue([]);
    await runCli(["lint", "--site", "x/docs-site"], { cwd: world.dir });
    expect(fakes.findSiteDir).toHaveBeenCalledWith("x/docs-site", world.dir);
    expect(fakes.lintDocs).toHaveBeenCalledWith(world.paths.docsDir, { repoRoot: world.dir });
    expect(world.calls).toEqual([]);
  });

  test("a configuration that is not valid: every problem, exit 1", async () => {
    fakes.readConfig.mockImplementation(() => {
      throw new ConfigError(["name is required", "domain is not a domain"]);
    });
    const { code, stderr } = await runCli(["lint"], { cwd: world.dir });
    expect(code).toBe(1);
    expect(stderr.split("\n")).toEqual([
      "lint: error: name is required",
      "lint: error: domain is not a domain",
    ]);
    expect(fakes.lintDocs).not.toHaveBeenCalled();
  });

  test("a docs folder that does not exist", async () => {
    fakes.pathsFor.mockReturnValue({ ...world.paths, docsDir: join(world.dir, "nope") });
    const { code, stderr } = await runCli(["lint"], { cwd: world.dir });
    expect(code).toBe(1);
    expect(stderr).toBe(
      `lint: error: the Markdown folder ${join(world.dir, "nope")} does not exist`,
    );
  });

  test("no site folder is exit 1 with the message of findSiteDir", async () => {
    fakes.findSiteDir.mockImplementation(() => {
      throw new Error("no docusystem.config.json found (searched /x and /x/docs-site)");
    });
    const { code, stderr } = await runCli(["lint"], { cwd: world.dir });
    expect(code).toBe(1);
    expect(stderr).toBe(
      "docusystem: no docusystem.config.json found (searched /x and /x/docs-site)",
    );
  });
});

describe("docusystem links", () => {
  const report = (over: Partial<LinkReport> = {}): LinkReport => ({
    pages: 6,
    checked: 889,
    errors: [],
    warnings: [],
    ...over,
  });
  const built = (): void => {
    mkdirSync(world.paths.dist, { recursive: true });
    writeFileSync(join(world.paths.dist, "index.html"), "<html></html>");
    mkdirSync(join(world.paths.root, ".generated"), { recursive: true });
    writeFileSync(
      world.paths.navFile,
      JSON.stringify({
        home: { label: "Home", url: "/docs/" },
        loose: [],
        sections: [],
        pages: {},
      }),
    );
  };

  test("crawls <site>/dist with the nav of the last build and exits 0", async () => {
    built();
    fakes.checkLinks.mockReturnValue(report());
    const { code, stdout, stderr } = await runCli(["links"], { cwd: world.dir });
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toBe("links: 6 page(s), 889 reference(s) checked");
    const [dist, options] = fakes.checkLinks.mock.calls[0] as [
      string,
      { nav: { home: { url: string } } },
    ];
    expect(dist).toBe(world.paths.dist);
    expect(options.nav.home.url).toBe("/docs/");
  });

  test("errors are printed one per line, exit 1; warnings do not fail it", async () => {
    built();
    fakes.checkLinks.mockReturnValue(
      report({
        errors: [{ page: "/docs/a/", message: 'link to "/x/" does not resolve' }],
        warnings: [{ page: "/docs/b/", message: "external link not checked" }],
      }),
    );
    const { code, stderr } = await runCli(["links"], { cwd: world.dir });
    expect(code).toBe(1);
    expect(stderr.split("\n")).toEqual([
      "links: warning: /docs/b/  external link not checked",
      'links: error: /docs/a/  link to "/x/" does not resolve',
      "links: 1 error(s)",
    ]);
    fakes.checkLinks.mockReturnValue(report({ warnings: [{ page: "/", message: "w" }] }));
    expect((await runCli(["links"], { cwd: world.dir })).code).toBe(0);
  });

  test("a dist argument is resolved against the current folder", async () => {
    built();
    fakes.checkLinks.mockReturnValue(report());
    const other = join(world.dir, "elsewhere", "public");
    mkdirSync(other, { recursive: true });
    await runCli(["links", "elsewhere/public"], { cwd: world.dir });
    expect(fakes.checkLinks.mock.calls[0]?.[0]).toBe(other);
  });

  test("no built site is exit 1 and says what to run", async () => {
    const { code, stderr } = await runCli(["links"], { cwd: world.dir });
    expect(code).toBe(1);
    expect(stderr).toBe(
      `links: error: ${world.paths.dist} is not a built site: run docusystem build first`,
    );
    const given = await runCli(["links", "nowhere"], { cwd: world.dir });
    expect(given.stderr).toBe(`links: error: ${join(world.dir, "nowhere")} is not a built site`);
    expect(fakes.checkLinks).not.toHaveBeenCalled();
  });

  test("without nav data (a dist built elsewhere) the crawl goes on and says what it skips", async () => {
    mkdirSync(world.paths.dist, { recursive: true });
    fakes.checkLinks.mockReturnValue(report());
    const { code, stderr } = await runCli(["links"], { cwd: world.dir });
    expect(code).toBe(0);
    expect(stderr).toContain("no nav data at");
    expect(fakes.checkLinks).toHaveBeenCalledWith(world.paths.dist, undefined);
  });

  test("nav data that is not JSON is a warning too", async () => {
    mkdirSync(world.paths.dist, { recursive: true });
    mkdirSync(join(world.paths.root, ".generated"), { recursive: true });
    writeFileSync(world.paths.navFile, "{ not json");
    fakes.checkLinks.mockReturnValue(report());
    const { code, stderr } = await runCli(["links"], { cwd: world.dir });
    expect(code).toBe(0);
    expect(stderr).toContain("is not readable");
  });

  test("a configuration that is not valid: exit 1", async () => {
    fakes.readConfig.mockImplementation(() => {
      throw new ConfigError(["name is required"]);
    });
    const { code, stderr } = await runCli(["links"], { cwd: world.dir });
    expect(code).toBe(1);
    expect(stderr).toBe("links: error: name is required");
  });

  test("takes at most one argument", async () => {
    const { code, stderr } = await runCli(["links", "a", "b"], { cwd: world.dir });
    expect(code).toBe(2);
    expect(stderr).toContain("links takes at most one argument");
  });
});
