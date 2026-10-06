import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { REPO_ROOT, tempDir, writeTree } from "../support/index.js";
import { rehearsal, type Rehearse } from "./support.js";

// scripts/rehearse-pilots.mjs: the parts that need no network. The rehearsal itself (clones, Bun, npm, the
// packed tarball) is run by hand against the three pilots; its result is in the pull request.

let r: Rehearse;

beforeAll(async () => {
  r = await rehearsal();
});

describe("what section 10.4 says git status shows", () => {
  const tracked = [
    "README.md",
    ".github/workflows/docs.yml",
    "docs-site/.gitignore",
    "docs-site/package.json",
    "docs-site/bun.lock",
    "docs-site/docs.config.json",
    "docs-site/components/docs-footer.json",
    "docs/README.md",
  ];

  test("every tracked file of the site folder goes, except package.json and .gitignore", () => {
    expect(r.expectedStatus({ tracked })).toEqual({
      deleted: [
        "docs-site/bun.lock",
        "docs-site/components/docs-footer.json",
        "docs-site/docs.config.json",
      ],
      modified: [
        ".github/dependabot.yml",
        ".github/workflows/dependabot-auto-merge.yml",
        ".github/workflows/docs.yml",
        "docs-site/.gitignore",
        "docs-site/package.json",
      ],
      created: [".github/workflows/docs-publish.yml", "docs-site/docusystem.config.json"],
    });
  });

  test("a file the migration keeps for review is not expected to go", () => {
    const expected = r.expectedStatus({ tracked, kept: ["docs-site/components/docs-footer.json"] });
    expect(expected.deleted).toEqual(["docs-site/bun.lock", "docs-site/docs.config.json"]);
  });

  test("reads git status --porcelain", () => {
    const status = r.parseStatus(
      [
        " D docs-site/a.json",
        "D  docs-site/b.json",
        " M .github/workflows/docs.yml",
        "M  docs-site/package.json",
        "?? docs-site/docusystem.config.json",
        "A  staged.txt",
        "R  old -> new",
        "",
      ].join("\n"),
    );
    expect(status.deleted).toEqual(["docs-site/a.json", "docs-site/b.json"]);
    expect(status.modified).toEqual([".github/workflows/docs.yml", "docs-site/package.json"]);
    expect(status.created).toEqual(["docs-site/docusystem.config.json"]);
    expect(status.other).toEqual(["A staged.txt", "R old -> new"]);
  });

  test("says what is missing and what is extra", () => {
    const expected = r.expectedStatus({ tracked });
    const actual = {
      deleted: ["docs-site/bun.lock", "docs-site/extra.json"],
      modified: [...expected.modified],
      created: [...expected.created],
      other: ["A  x"],
    };
    expect(r.statusDifferences(expected, actual)).toEqual([
      "docs-site/components/docs-footer.json should be deleted and is not",
      "docs-site/docs.config.json should be deleted and is not",
      "docs-site/extra.json is deleted and should not be",
      "unexpected status: A  x",
    ]);
    expect(r.statusDifferences(expected, { ...expected, other: [] })).toEqual([]);
  });
});

describe("reading what the command line prints", () => {
  const output = [
    "Done: 13 routes → 56 files",
    "assert: ok: 13 pages built (13 expected)",
    "contrast: 148 color pair(s) checked, 0 below the minimum",
    "links: 13 page(s), 978 reference(s) checked",
    "check: all steps passed",
  ].join("\n");

  test("takes the numbers of a passing check", () => {
    expect(r.readCheckOutput(output)).toEqual({
      pages: 13,
      references: 978,
      routes: 13,
      contrastPairs: 148,
      contrastFailures: 0,
      passed: true,
    });
  });

  test("a failing or unreadable output has no numbers and has not passed", () => {
    expect(r.readCheckOutput("check: FAILED")).toEqual({
      pages: null,
      references: null,
      routes: null,
      contrastPairs: null,
      contrastFailures: null,
      passed: false,
    });
  });

  test("counts the documents of the search index", () => {
    const dist = writeTree(tempDir("docusystem-dist-"), {
      "search-index.json": JSON.stringify({ version: 1, documents: [{}, {}, {}] }),
    });
    expect(r.searchDocuments(dist)).toBe(3);
    expect(r.searchDocuments(tempDir("docusystem-dist-"))).toBeNull();
    const odd = writeTree(tempDir("docusystem-dist-"), { "search-index.json": "{}" });
    expect(r.searchDocuments(odd)).toBeNull();
  });
});

describe("the command line", () => {
  test("by default rehearses the three pilots, on Node, with the placeholder commit", () => {
    const options = r.parseOptions([]);
    expect(options).toMatchObject({ runtime: "node", sha: "0".repeat(40), keep: false });
    expect((options.pilots as Array<{ name: string }>).map((p) => p.name)).toEqual([
      "frappe-nix",
      "erpnext_taskview",
      "cloudflare-email-relay",
    ]);
    for (const pilot of options.pilots as Array<{ name: string; url: string }>) {
      expect(pilot.url).toBe(`https://github.com/Avunu/${pilot.name}.git`);
    }
  });

  test("takes a subset, another source and the runtime", () => {
    const options = r.parseOptions([
      "--pilot",
      "erpnext_taskview",
      "--source",
      "erpnext_taskview=/tmp/clone",
      "--runtime",
      "bun",
      "--keep",
    ]);
    expect(options.pilots).toEqual([{ name: "erpnext_taskview", url: "/tmp/clone" }]);
    expect(options).toMatchObject({ runtime: "bun", keep: true });
  });

  test("refuses what it cannot use", () => {
    expect(r.parseOptions(["--pilot", "other"]).error).toContain("--pilot must be one of");
    expect(r.parseOptions(["--source", "frappe-nix"]).error).toContain("--source must be");
    expect(r.parseOptions(["--source", "nobody=/x"]).error).toContain("--source must be");
    expect(r.parseOptions(["--runtime", "deno"]).error).toContain("--runtime must be node or bun");
    expect(r.parseOptions(["--workflow-sha", "abc"]).error).toContain("40-character");
    expect(r.parseOptions(["--nope"]).error).toBeDefined();
    expect(r.parseOptions(["--help"]).help).toBe(true);
  });

  test("the script prints its usage and exits 2 on a usage error, without touching anything", () => {
    const script = join(REPO_ROOT, "scripts", "rehearse-pilots.mjs");
    const help = spawnSync(process.execPath, [script, "--help"], { encoding: "utf8" });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("usage: node scripts/rehearse-pilots.mjs");
    const bad = spawnSync(process.execPath, [script, "--pilot", "x"], { encoding: "utf8" });
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain("--pilot must be one of");
  });

  test("the pilots are the ones of the decision record, and only the 1px fix may differ", () => {
    expect(r.PILOTS.map((p) => p.name)).toEqual([
      "frappe-nix",
      "erpnext_taskview",
      "cloudflare-email-relay",
    ]);
    expect(r.ALLOWED_DIFFERENCES).toEqual(["components/docs-enhance.js"]);
  });
});

describe("the summary", () => {
  test("says which pilots passed and why the others did not", () => {
    const lines = r
      .renderSummary([
        {
          name: "frappe-nix",
          ok: true,
          stage: "done",
          seconds: 13,
          problems: [],
          migration: { deleted: 80, modified: 5, created: 2, kept: [], advice: 2 },
          check: { pages: 33, references: 3389, routes: 33, contrastPairs: 148 },
          compare: {
            files: [77, 77],
            differences: [],
            allowed: ["components/docs-enhance.js"],
            vendoredSkipped: 3,
            searchDocuments: [247, 247],
          },
        },
        {
          name: "erpnext_taskview",
          ok: false,
          stage: "compare",
          seconds: 12,
          problems: ["1 file(s) differ:\n  index.html: the page differs"],
        },
      ])
      .join("\n");
    expect(lines).toContain("PASS  frappe-nix  (13 s)");
    expect(lines).toContain("migration: 80 deleted, 5 modified, 2 created");
    expect(lines).toContain("3389 references crawled");
    expect(lines).toContain("search index 247 and 247 documents");
    expect(lines).toContain("FAIL (compare)  erpnext_taskview");
    expect(lines).toContain("index.html: the page differs");
    expect(lines).toContain("1 of 2 pilot(s) passed");
  });
});
