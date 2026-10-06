import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { ConfigError } from "../../src/lib/config.js";
import { navTree } from "../../src/commands/info.js";
import type { PipelineDeps } from "../../src/lib/pipeline.js";
import type { NavData } from "../../src/lib/types.js";
import { version } from "../../src/lib/package-info.js";
import { isWindows, runCli, slash, writeTree } from "../support/index.js";
import { FAKE_JX, makeWorld, type World } from "./support/world.js";

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

// WP1 (config) and WP2 (the Jx helpers) are fakes here; the real ones run in test/integration.
const fakes = vi.hoisted(() => ({
  findSiteDir: vi.fn(),
  readConfig: vi.fn(),
  pathsFor: vi.fn(),
  resolveBranch: vi.fn(),
  jxVersions: vi.fn(),
}));
vi.mock("../../src/lib/config.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/lib/config.js")>();
  return {
    ...real,
    findSiteDir: fakes.findSiteDir,
    readConfig: fakes.readConfig,
    pathsFor: fakes.pathsFor,
    resolveBranch: fakes.resolveBranch,
  };
});
vi.mock("../../src/lib/jx.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/lib/jx.js")>();
  return { ...real, jxVersions: fakes.jxVersions, jxCli: () => FAKE_JX };
});

const JX = {
  "@jxsuite/compiler": "5.0.0",
  "@jxsuite/parser": "2.0.0",
  "@jxsuite/runtime": "4.0.3",
  "@jxsuite/search": "0.4.0",
};

let world: World;
beforeEach(() => {
  world = makeWorld();
  holder.deps = world.deps;
  for (const fake of Object.values(fakes)) fake.mockReset();
  fakes.findSiteDir.mockReturnValue(world.siteDir);
  fakes.readConfig.mockReturnValue(world.config);
  fakes.pathsFor.mockReturnValue(world.paths);
  fakes.resolveBranch.mockReturnValue("main");
  fakes.jxVersions.mockReturnValue(JX);
});

const info = (flags: string[] = []) => runCli(["info", ...flags], { cwd: world.dir });

describe("docusystem info", () => {
  test("states versions, folders, branch and the command to run Jx by hand (snapshot)", async () => {
    const { code, stdout, stderr } = await info();
    expect(code).toBe(0);
    expect(stderr).toBe("");
    // The paths are the platform's; the expectation is written once with `/` (and the folder of the package starts with a drive on Windows).
    const text = slash(
      stdout.replaceAll(world.dir, "<repo>").replaceAll(process.execPath, "<node>"),
    );
    const root = isWindows ? "[A-Za-z]:/" : "/";
    expect(text.split("\n")).toEqual([
      expect.stringMatching(new RegExp(`^@avunu/docusystem ${version}  \\(${root}.+\\)$`)),
      expect.stringMatching(/^runtime:    (node|bun) \d+\.\d+\.\d+/),
      "jx:         @jxsuite/compiler 5.0.0, @jxsuite/parser 2.0.0, @jxsuite/runtime 4.0.3, @jxsuite/search 0.4.0",
      "contract:   workflow contract 1",
      "site:       <repo>/docs-site",
      "project:    Example (example, general), https://example.avunu.net/",
      "repository: <repo>",
      "markdown:   <repo>/docs",
      "branch:     main",
      "jx root:    <repo>/docs-site/.docusystem/site  (not assembled yet: run docusystem build)",
      "published:  <repo>/docs-site/dist  (missing)",
      "overrides:  none (every file comes from the package)",
      "public:     none",
      "",
      "To run Jx by hand on the assembled project (docusystem jx <command> does the same):",
      `  <node> ${FAKE_JX} build <repo>/docs-site/.docusystem/site`,
    ]);
  });

  test("lists the shell's overrides and public files, and what the last build did", async () => {
    writeTree(world.siteDir, {
      "overrides/components/docs-footer.json": "{}",
      "overrides/pages/about.json": "{}",
      "overrides/.ejected.json": "{}",
      "public/favicon.svg": "<svg/>",
    });
    mkdirSync(join(world.paths.work), { recursive: true });
    mkdirSync(world.paths.root, { recursive: true });
    mkdirSync(world.paths.dist, { recursive: true });
    writeFileSync(
      world.paths.manifest,
      JSON.stringify({
        docusystem: "0.1.0",
        runtime: "node 24.21.0",
        jx: JX,
        files: { a: "package", b: "override" },
        shadowed: ["components/docs-footer.json"],
        added: ["pages/about.json"],
        catalog: "bundled",
        strict: true,
      }),
    );
    const { stdout } = await info();
    expect(stdout).toContain("overrides:  components/docs-footer.json, pages/about.json\n");
    expect(stdout).not.toContain(".ejected.json");
    expect(stdout).toContain("public:     favicon.svg\n");
    expect(stdout).toContain(
      "last build: docusystem 0.1.0 on node 24.21.0, strict, catalog bundled, 2 file(s) in the root, replaces components/docs-footer.json, adds pages/about.json\n",
    );
    expect(stdout).toContain("jx root:    " + world.paths.root + "\n");
    expect(stdout).not.toContain("(missing)");
  });

  test("the jx setting is an override: 'none' is not claimed, and it follows the files of overrides/", async () => {
    const jx = { $head: [{ tagName: "meta", attributes: { name: "author", content: "Avunu" } }] };
    const jxLine = 'the "jx" setting of docusystem.config.json (merged into project.json)';
    fakes.readConfig.mockReturnValue({ ...world.config, jx });
    expect((await info()).stdout).toContain(`overrides:  ${jxLine}\n`);
    writeTree(world.siteDir, { "overrides/pages/about.json": "{}" });
    expect((await info()).stdout).toContain(`overrides:  pages/about.json, ${jxLine}\n`);
    fakes.readConfig.mockReturnValue({ ...world.config, jx: {} });
    expect((await info()).stdout).toContain("overrides:  pages/about.json\n");
  });

  test("--json prints the same facts as one JSON object", async () => {
    const { code, stdout } = await info(["--json"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      docusystem: { name: "@avunu/docusystem", version },
      workflowContract: 1,
      jx: JX,
      site: world.siteDir,
      config: { slug: "example", domain: "example.avunu.net" },
      configProblems: [],
      branch: "main",
      overrides: [],
      publicFiles: [],
      lastBuild: null,
      jxCommand: [process.execPath, FAKE_JX, "build", world.paths.root],
    });
    expect((parsed.paths as { dist: string }).dist).toBe(world.paths.dist);
  });

  test("an invalid configuration is reported, not fatal: this is the command to run when it does not build", async () => {
    fakes.readConfig.mockImplementation(() => {
      throw new ConfigError([
        "name is required",
        '"tagLine" is not a docusystem setting; did you mean "tagline"?',
      ]);
    });
    const { code, stdout } = await info();
    expect(code).toBe(0);
    expect(stdout).toContain(
      'Problems:\n  name is required\n  "tagLine" is not a docusystem setting; did you mean "tagline"?',
    );
    expect(stdout).toContain(`site:       ${world.siteDir}`);
    expect(stdout).not.toContain("jx root:");
    expect(stdout).not.toContain("To run Jx by hand");
    const json = JSON.parse((await info(["--json"])).stdout) as { config: unknown; paths: unknown };
    expect(json.config).toBeNull();
    expect(json.paths).toBeNull();
  });

  test("the Jx packages missing is a problem line, not a crash", async () => {
    fakes.jxVersions.mockImplementation(() => {
      throw new Error("Cannot find package '@jxsuite/compiler'");
    });
    const { code, stdout } = await info();
    expect(code).toBe(0);
    expect(stdout).toContain("jx:         (not found)");
    expect(stdout).toContain(
      "the Jx packages cannot be found: Cannot find package '@jxsuite/compiler'",
    );
  });

  test("no site folder is exit 1 (findSiteDir's message)", async () => {
    fakes.findSiteDir.mockImplementation(() => {
      throw new Error("no docusystem.config.json found");
    });
    const { code, stderr } = await info();
    expect(code).toBe(1);
    expect(stderr).toBe("docusystem: no docusystem.config.json found");
  });

  test("a missing docs folder is marked", async () => {
    fakes.pathsFor.mockReturnValue({ ...world.paths, docsDir: join(world.dir, "gone") });
    expect((await info()).stdout).toContain(`markdown:   ${join(world.dir, "gone")}  (missing)`);
  });
});

describe("docusystem info --nav", () => {
  const nav: NavData = {
    home: { label: "Example", url: "/docs/" },
    loose: [{ label: "Changelog", url: "/docs/changelog/" }],
    sections: [
      {
        label: "Guide",
        url: "/docs/guide/",
        urls: [],
        pages: [{ label: "Install", url: "/docs/guide/install/" }],
        groups: [
          {
            label: "Advanced",
            url: null,
            urls: [],
            pages: [{ label: "Tuning", url: "/docs/guide/advanced/tuning/" }],
          },
        ],
      },
    ],
    expandAll: true,
    pages: {},
    flat: [],
    featured: [],
  };

  test("prints the sidebar tree of the Markdown as it is now, assembling the root without building", async () => {
    world.deps.writeNav = () => {
      world.calls.push("nav");
      return { nav, warnings: [], pages: 3 };
    };
    const { code, stdout } = await info(["--nav"]);
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
    expect(stdout).toContain(
      [
        "Sidebar:",
        "  Example  /docs/",
        "  Changelog  /docs/changelog/",
        "  Guide/  /docs/guide/",
        "    Install  /docs/guide/install/",
        "    Advanced/",
        "      Tuning  /docs/guide/advanced/tuning/",
      ].join("\n"),
    );
    expect(stdout).not.toContain("assemble:");
  });

  test("--json carries the nav", async () => {
    world.deps.writeNav = () => ({ nav, warnings: [], pages: 3 });
    const parsed = JSON.parse((await info(["--nav", "--json"])).stdout) as { nav: NavData };
    expect(parsed.nav.home.url).toBe("/docs/");
  });

  test("when the root cannot be assembled the problems are printed and the exit code is 1", async () => {
    world.assemblyErrors = ["overrides/components/sub/x.json: components must be flat"];
    const { code, stderr, stdout } = await info(["--nav"]);
    expect(code).toBe(1);
    expect(stderr).toContain("components must be flat");
    expect(stdout).not.toContain("Sidebar:");
  });

  test("navTree is a plain function of the data", () => {
    expect(navTree({ ...nav, loose: [], sections: [] })).toEqual(["Example  /docs/"]);
  });
});
