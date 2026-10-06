import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { tempDir, writeTree } from "../support/index.js";
import { REPO_ROOT, pack, runScript, script, suiteDir } from "./support.js";

// scripts/test-pack.mjs. The real thing needs the packed package and a registry (CI runs it per row of the
// consumer matrix); here its logic is tested with the Markdown expectations it derives, and its plumbing
// is driven end to end with a stand-in package (fixtures/stub-cli) that builds a hand-made site.

interface Derived {
  pages: number;
  alerts: number;
  titles: Array<[string, string]>;
  hrefs: string[];
  srcs: string[];
}
interface TestPack {
  parseOptions(argv: string[]): Record<string, any>;
  routeOfMarkdown(rel: string): string;
  deriveExpectations(o: {
    root: string;
    docs?: string;
    repo: string;
    branch?: string;
    name: string;
  }): Derived;
  SHELL_FILES: string[];
}

let testPack: TestPack;
beforeAll(async () => {
  testPack = await script<TestPack>("test-pack.mjs");
});

describe("the command line", () => {
  it("defaults to npm, node and a hoisted install", () => {
    expect(testPack.parseOptions([])).toEqual({
      pm: "npm",
      runtime: "node",
      linker: "hoisted",
      workspace: false,
      tarball: undefined,
      keep: undefined,
      doctor: false,
      init: false,
    });
  });

  it.each([
    [["--pm", "bun", "--runtime", "bun", "--linker", "isolated"]],
    [["--pm", "bun", "--runtime", "node", "--linker", "isolated"]],
    [["--pm", "npm", "--workspace", "--doctor"]],
  ])("accepts %j", (argv) => {
    expect(testPack.parseOptions(argv).error).toBeUndefined();
  });

  it.each([
    [["--pm", "yarn"], /--pm must be npm or bun/],
    [["--runtime", "deno"], /--runtime must be node or bun/],
    [["--linker", "linked"], /--linker must be hoisted or isolated/],
    [["--pm", "npm", "--linker", "isolated"], /needs --pm bun/],
    [["--bogus"], /Unknown option/],
    [["extra"], /Unexpected argument/],
  ] as Array<[string[], RegExp]>)("refuses %j", (argv, message) => {
    expect(testPack.parseOptions(argv).error).toMatch(message);
    expect(runScript("test-pack.mjs", argv).code).toBe(2);
  });
});

describe("routeOfMarkdown", () => {
  it.each([
    ["README.md", "/docs/"],
    ["readme.md", "/docs/"],
    ["index.md", "/docs/"],
    ["install.md", "/docs/install/"],
    ["guide/install.md", "/docs/guide/install/"],
    ["guide/README.md", "/docs/guide/"],
    ["guide/advanced/index.md", "/docs/guide/advanced/"],
  ])("%s is %s", (file, route) => {
    expect(testPack.routeOfMarkdown(file)).toBe(route);
  });
});

describe("what the Markdown says the site must contain", () => {
  const repo = "https://github.com/Avunu/x";
  const derive = (
    files: Record<string, string>,
    extra: Partial<Parameters<TestPack["deriveExpectations"]>[0]> = {},
  ) => {
    const root = writeTree(tempDir(), files);
    return testPack.deriveExpectations({ root, repo, name: "Project", ...extra });
  };

  it("derives the titles, with the site name, from the front matter or else the first heading", () => {
    const d = derive({
      "docs/README.md": "---\ntitle: Welcome\n---\n\n# Welcome\n",
      "docs/a.md": "# From the heading\n",
      "docs/b.md": '---\ntitle: "Quoted: yes"\n---\n',
    });
    expect(d.titles).toEqual([
      ["/docs/", "Welcome · Project"],
      ["/docs/a/", "From the heading · Project"],
      ["/docs/b/", "Quoted: yes · Project"],
    ]);
    expect(d.pages).toBe(3);
  });

  it("reads past a copyright comment above the front matter", () => {
    const d = derive({
      "docs/README.md": "<!-- Copyright (c) 2026 -->\n---\ntitle: Stamped\n---\n# Stamped\n",
    });
    expect(d.titles).toEqual([["/docs/", "Stamped · Project"]]);
  });

  it("names a page whose title is the project's name just Documentation, as the page template does", () => {
    const d = derive({ "docs/README.md": "---\ntitle: project\n---\n" });
    expect(d.titles).toEqual([["/docs/", "Documentation · Project"]]);
  });

  it("counts the alerts, in any case, and not the ones in code", () => {
    const d = derive({
      "docs/README.md":
        "> [!NOTE]\n> a\n\n> [!warning]\n> b\n\n```md\n> [!TIP]\n> c\n```\n\n> [!CAUTION]\n> d\n",
    });
    expect(d.alerts).toBe(3);
  });

  it("expects a link to another page as its route with the anchor, an edit link for every page", () => {
    const d = derive({
      "docs/README.md": "[a](guide/a.md#top) and [b](guide/)\n",
      "docs/guide/a.md": "[home](../README.md)\n",
    });
    expect(d.hrefs).toEqual(
      expect.arrayContaining([
        "/docs/guide/a/#top",
        "/docs/",
        `${repo}/edit/main/docs/README.md`,
        `${repo}/edit/main/docs/guide/a.md`,
      ]),
    );
  });

  it("expects a file, a folder and an image of the repository on GitHub, on the branch", () => {
    const d = derive(
      {
        "docs/README.md": "[f](../src/a.ts#L3) [d](../src) ![i](../assets/l.svg) [l](../LICENSE)\n",
        "src/a.ts": "",
        "assets/l.svg": "<svg/>",
        LICENSE: "MIT",
      },
      { branch: "develop" },
    );
    expect(d.hrefs).toEqual(
      expect.arrayContaining([
        `${repo}/blob/develop/src/a.ts#L3`,
        `${repo}/tree/develop/src`,
        `${repo}/blob/develop/LICENSE`,
      ]),
    );
    expect(d.srcs).toEqual([`${repo}/raw/develop/assets/l.svg`]);
  });

  it("expects nothing of external links, anchors, an image of docs/, links in code and links in fences", () => {
    const d = derive({
      "docs/README.md":
        "[x](https://example.net/a.md) [y](#top) [z](mailto:a@b.c) ![p](img/p.png) `[c](../src/a.ts)`\n\n```md\n[f](../src/a.ts)\n```\n",
      "docs/img/p.png": "png",
      "src/a.ts": "",
    });
    expect(d.srcs).toEqual([]);
    expect(d.hrefs).toEqual([`${repo}/edit/main/docs/README.md`]);
  });

  it("does not follow a link out of the repository", () => {
    const root = writeTree(tempDir(), { "repo/docs/README.md": "[x](../../outside.md)\n" });
    const d = testPack.deriveExpectations({ root: join(root, "repo"), repo, name: "P" });
    expect(d.hrefs).toEqual([`${repo}/edit/main/docs/README.md`]);
  });
});

describe("driven end to end with a stand-in package", () => {
  let tarball: string;
  let expectFile: string;

  beforeAll(() => {
    tarball = pack(
      join(REPO_ROOT, "test", "e2e", "fixtures", "stub-cli"),
      suiteDir("docusystem-stub-pack-"),
    );
    // what the stand-in builds: exactly what the example's Markdown says
    const example = join(REPO_ROOT, "examples", "basic");
    const config = JSON.parse(
      readFileSync(join(example, "docs-site", "docusystem.config.json"), "utf8"),
    ) as {
      repo: string;
      name: string;
    };
    const derived = testPack.deriveExpectations({
      root: example,
      repo: config.repo,
      name: config.name,
    });
    expectFile = join(suiteDir("docusystem-stub-expect-"), "expect.json");
    writeFileSync(expectFile, JSON.stringify(derived));
  });

  const run = (args: string[] = [], env: Record<string, string> = {}) =>
    runScript("test-pack.mjs", ["--tarball", tarball, ...args], {
      env: { ...process.env, STUB_EXPECT: expectFile, ...env },
    });

  it("installs the tarball, checks, builds, asserts the output and the clean git status", () => {
    const r = run();
    expect(r.code, r.output).toBe(0);
    expect(r.output).toMatch(/docusystem --version prints 0\.0\.1/);
    expect(r.output).toMatch(/\$GITHUB_OUTPUT has dist, page-url and pages=\d+/);
    expect(r.output).toMatch(/assert-dist: (\d+)\/\1 checks passed/);
    expect(r.output).toMatch(/git status shows only package-lock\.json/);
    expect(r.output).toMatch(/test-pack: ok \(pm=npm, runtime=node, linker=hoisted\)/);
  });

  it("puts the shell in a workspace when asked, where the lockfile is the root's", () => {
    const r = run(["--workspace"]);
    expect(r.code, r.output).toBe(0);
    expect(r.output).toMatch(/test-pack: ok \(pm=npm, runtime=node, linker=hoisted, workspace\)/);
  });

  it("keeps the consumer repository, committed, when asked", () => {
    const keep = join(suiteDir("docusystem-stub-keep-"), "consumer");
    const r = run(["--keep", keep]);
    expect(r.code, r.output).toBe(0);
    expect(existsSync(join(keep, ".git"))).toBe(true);
    expect(existsSync(join(keep, "docs-site", "dist", "CNAME"))).toBe(true);
    expect(
      JSON.parse(readFileSync(join(keep, "docs-site", "package.json"), "utf8")).dependencies[
        "@avunu/docusystem"
      ],
    ).toMatch(/^file:.*\.tgz$/);
  });

  it("keeps the consumer when it fails too, to be looked at", () => {
    const keep = join(suiteDir("docusystem-stub-keep-"), "consumer");
    expect(run(["--keep", keep], { STUB_BREAK: "no-cname" }).code).toBe(1);
    expect(existsSync(join(keep, "docs-site", "node_modules"))).toBe(true);
  });

  it("fails when the output lacks something, naming it", () => {
    const r = run([], { STUB_BREAK: "no-cname" });
    expect(r.code).toBe(1);
    expect(r.output).toMatch(/FAIL CNAME says the configured domain/);
    expect(r.output).not.toMatch(/test-pack: ok/);
  });

  it("fails when the installed command prints a different version from the tarball's", () => {
    const r = run([], { STUB_VERSION: "9.9.9" });
    expect(r.code).toBe(1);
    expect(r.output).toMatch(/docusystem --version prints 9\.9\.9, the tarball is 0\.0\.1/);
  });

  it("fails when check --ci writes no step outputs", () => {
    const r = run([], { STUB_NO_OUTPUTS: "1" });
    expect(r.code).toBe(1);
    expect(r.output).toMatch(/\$GITHUB_OUTPUT has dist=undefined/);
  });

  it("fails when the build leaves anything but the lockfile in the working tree", () => {
    const r = run([], { STUB_DIRTY: "1" });
    expect(r.code).toBe(1);
    expect(r.output).toMatch(
      /git status shows more than the lockfile:\n\?\? docs-site\/stray\.txt/,
    );
  });

  it("runs doctor when asked, and fails when doctor does", () => {
    expect(run(["--doctor"]).code).toBe(0);
    const r = run(["--doctor"], { STUB_DOCTOR_FAIL: "1" });
    expect(r.code).toBe(1);
    expect(r.output).toMatch(/doctor exited with 1/);
  });

  it("checks that init writes the example's shell when asked", () => {
    const from = join(REPO_ROOT, "examples", "basic");
    const ok = run(["--init"], { STUB_INIT_FROM: from });
    expect(ok.code, ok.output).toBe(0);
    expect(ok.output).toMatch(/init writes exactly the example's shell/);
  });

  it("fails when init writes something else, showing both", () => {
    const from = join(REPO_ROOT, "examples", "basic");
    const r = run(["--init"], { STUB_INIT_FROM: from, STUB_INIT_BREAK: "1" });
    expect(r.code).toBe(1);
    expect(r.output).toMatch(
      /init does not write the example:\ndocs-site\/\.gitignore differs from what init writes:/,
    );
    expect(r.output).toMatch(/--- init\nnode_modules\/\ndist\/\n\.docusystem\/\nextra\//);
  });

  it("fails, exit 1, on a tarball that does not exist", () => {
    const r = runScript("test-pack.mjs", ["--tarball", "/nonexistent.tgz"]);
    expect(r.code).toBe(1);
    expect(r.output).toMatch(/does not exist/);
  });

  it("removes its temporary files", () => {
    const tmp = suiteDir("docusystem-stub-tmp-");
    const r = runScript("test-pack.mjs", ["--tarball", tarball], {
      env: { ...process.env, STUB_EXPECT: expectFile, DOCUSYSTEM_TMP: tmp },
    });
    expect(r.code, r.output).toBe(0);
    expect(readdirSync(tmp)).toEqual([]);
  });
});

describe("the shell it expects", () => {
  it("is the three files of section 2.1", () => {
    expect(testPack.SHELL_FILES).toEqual([".gitignore", "docusystem.config.json", "package.json"]);
  });
});
