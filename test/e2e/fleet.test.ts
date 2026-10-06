import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { git, initRepo, tempDir, writeTree, type TreeSpec } from "../support/index.js";
import { REPO_ROOT, pack, runScript, script, suiteDir } from "./support.js";

// scripts/fleet.mjs and fleet.json. The 21 repositories are real and public, so the tests of the script use
// local bare repositories ("<base>/Avunu/<name>.git") and a stand-in package (fixtures/stub-cli); the run
// against the real repositories, with the real package, is the fleet job.

interface Entry {
  repo: string;
  ref?: string;
  init?: string[];
}
interface Row {
  repo: string;
  ok: boolean;
  stage: string;
  outcome: string;
  reason?: string;
  removed: string[];
  lines: string[];
}
interface Fleet {
  loadFleet(file: string): Entry[];
  loadExpected(file: string, fleet: Entry[]): Record<string, string>;
  problemLines(output: string, limit?: number, strip?: string[]): string[];
  classify(
    results: Array<{ repo: string; ok: boolean }>,
    expected: Record<string, string>,
  ): Array<{ repo: string; ok: boolean; outcome: string }>;
  renderSummary(rows: unknown[], o?: { enforce?: boolean }): string;
  parseOptions(argv: string[], env?: Record<string, string>): Record<string, any>;
  removeStarter(dir: string): string[];
}

let fleet: Fleet;
beforeAll(async () => {
  fleet = await script<Fleet>("fleet.mjs");
});

const write = (dir: string, name: string, value: unknown) => {
  const file = join(dir, name);
  writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  return file;
};

describe("fleet.json", () => {
  const entries = JSON.parse(readFileSync(join(REPO_ROOT, "fleet.json"), "utf8")) as Entry[];

  it("lists the 21 Avunu repositories, once each, and is valid", () => {
    expect(fleet.loadFleet(join(REPO_ROOT, "fleet.json"))).toHaveLength(21);
    expect(new Set(entries.map((e) => e.repo)).size).toBe(21);
    expect(entries.every((e) => e.repo.startsWith("Avunu/"))).toBe(true);
  });

  it("does not list the Jx repository, which is not Avunu's to adopt", () => {
    expect(entries.map((e) => e.repo)).not.toContain("jxsuite/jx");
  });

  it("carries the options the first batch found necessary", () => {
    const by = Object.fromEntries(entries.map((e) => [e.repo, e]));
    expect(by["Avunu/cloudflare-email-relay"]!.init).toEqual([
      "--domain",
      "cloudflare-email.avunu.net",
    ]);
    expect(by["Avunu/avunu-odoo-addons"]!.init).toEqual(["--slug", "avunu-odoo-addons"]);
    expect(entries.filter((e) => e.init)).toHaveLength(2);
  });

  it("has the pilots and the repositories with an underscore in their name", () => {
    const names = entries.map((e) => e.repo);
    for (const wanted of [
      "Avunu/frappe-nix",
      "Avunu/erpnext_taskview",
      "Avunu/cloudflare-email-relay",
      "Avunu/web_kiosk",
    ]) {
      expect(names).toContain(wanted);
    }
  });

  it("has reviewed exceptions that name only repositories of the fleet, each with a reason", () => {
    const expected = fleet.loadExpected(join(REPO_ROOT, "fleet.expected-failures.json"), entries);
    for (const [repo, reason] of Object.entries(expected)) {
      expect(entries.map((e) => e.repo)).toContain(repo);
      expect(reason.trim()).not.toBe("");
    }
  });

  it("holds no client name, pricing or secret: public names of Avunu repositories only", () => {
    const text = readFileSync(join(REPO_ROOT, "fleet.json"), "utf8");
    expect(text).not.toMatch(/token|secret|password|\$\d/i);
  });
});

describe("loadFleet and loadExpected refuse what is wrong, naming it", () => {
  const dir = () => tempDir("docusystem-fleet-file-");

  it.each([
    ["not JSON", "{", /cannot read/],
    ["an empty array", "[]", /non-empty array/],
    ["an object", "{}", /non-empty array/],
    ["an entry that is not an object", '["Avunu/x"]', /entry 1: not an object/],
    ["an unknown key", '[{"repo":"Avunu/x","branch":"main"}]', /unknown key "branch"/],
    ["a repository of another owner", '[{"repo":"someone/x"}]', /"repo" must be Avunu\/<name>/],
    [
      "a repository listed twice",
      '[{"repo":"Avunu/x"},{"repo":"Avunu/x"}]',
      /Avunu\/x is listed twice/,
    ],
    [
      "a ref with a space",
      '[{"repo":"Avunu/x","ref":"a b"}]',
      /"ref" must be a branch or tag name/,
    ],
    [
      "init that is not an array",
      '[{"repo":"Avunu/x","init":"--slug x"}]',
      /"init" must be an array of strings/,
    ],
    [
      "init that starts with a value",
      '[{"repo":"Avunu/x","init":["x"]}]',
      /must start with an option/,
    ],
    [
      "an option the job sets itself",
      '[{"repo":"Avunu/x","init":["--from-readme"]}]',
      /--from-readme is set by the fleet job/,
    ],
    ["--force", '[{"repo":"Avunu/x","init":["--force"]}]', /--force is set by the fleet job/],
  ])("%s", (_name, text, message) => {
    expect(() => fleet.loadFleet(write(dir(), "f.json", text))).toThrow(message);
  });

  it("accepts a ref and options", () => {
    const list = fleet.loadFleet(
      write(dir(), "f.json", '[{"repo":"Avunu/x","ref":"release/1.0","init":["--slug","x"]}]'),
    );
    expect(list).toEqual([{ repo: "Avunu/x", ref: "release/1.0", init: ["--slug", "x"] }]);
  });

  it.each([
    ["an array", "[]", /must be an object/],
    ["a repository outside the fleet", '{"Avunu/y":"why"}', /Avunu\/y is not in the fleet/],
    ["a missing reason", '{"Avunu/x":""}', /Avunu\/x needs a reason/],
    ["a reason that is not text", '{"Avunu/x":3}', /Avunu\/x needs a reason/],
  ])("expected failures: %s", (_name, text, message) => {
    const d = dir();
    expect(() => fleet.loadExpected(write(d, "e.json", text), [{ repo: "Avunu/x" }])).toThrow(
      message,
    );
  });
});

describe("reading a failure", () => {
  it("picks the first problem lines, shows paths as '.', and drops colour codes", () => {
    const output = [
      "== build ==",
      "stage: 3 file(s)",
      "\u001b[31mlint: error /w/repo/docs/a.md:3 broken link\u001b[0m",
      "ok line",
      "docusystem: 1 document problem(s) above fail the build.",
    ].join("\n");
    expect(fleet.problemLines(output, 10, ["/w/repo"])).toEqual([
      "lint: error ./docs/a.md:3 broken link",
      "docusystem: 1 document problem(s) above fail the build.",
    ]);
  });

  it("stops at the limit", () => {
    const output = Array.from({ length: 30 }, (_, i) => `error ${i}`).join("\n");
    expect(fleet.problemLines(output, 10)).toHaveLength(10);
    expect(fleet.problemLines(output, 10)[0]).toBe("error 0");
  });

  it("shows the last lines when none looks like a problem (a crash prints no tidy line)", () => {
    const output = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
    const lines = fleet.problemLines(output, 3);
    expect(lines).toEqual(["line 27", "line 28", "line 29"]);
  });

  it("shortens a very long line", () => {
    expect(fleet.problemLines(`error ${"x".repeat(500)}`)[0]!.length).toBeLessThanOrEqual(240);
  });
});

describe("classifying and reporting", () => {
  const results = [
    { repo: "Avunu/a", ok: true },
    { repo: "Avunu/b", ok: false },
    { repo: "Avunu/c", ok: false },
    { repo: "Avunu/d", ok: true },
  ];
  const expected = {
    "Avunu/c": "links to a file outside the repository",
    "Avunu/d": "was broken once",
  };

  it("tells a pass, a regression, an expected failure and an expected failure that now passes", () => {
    expect(fleet.classify(results, expected).map((r) => r.outcome)).toEqual([
      "pass",
      "regression",
      "expected",
      "fixed",
    ]);
  });

  it("renders one row per repository with its result and problem lines, escaping what breaks a table", () => {
    const rows = fleet.classify(results, expected).map((r) =>
      Object.assign({}, r, {
        stage: "check",
        removed: r.repo === "Avunu/a" ? ["docs-site", ".github/workflows/docs.yml"] : [],
        lines: r.ok ? [] : ["lint: error docs/x.md:1 a | b `code` <tag>"],
      }),
    );
    const text = fleet.renderSummary(rows, { enforce: true });
    expect(text).toMatch(/^### Fleet/m);
    expect(text).toMatch(/2 of 4 repositories pass\./);
    expect(text).toContain("| Repository | Result | First problem lines |");
    expect(text).toMatch(
      /\| Avunu\/a \| pass; the starter's docs-site and \.github\/workflows\/docs\.yml removed first \| {2}\|/,
    );
    expect(text).toMatch(
      /\| Avunu\/b \| FAIL \(check\) \| `lint: error docs\/x\.md:1 a \\\| b 'code' &lt;tag>` \|/,
    );
    expect(text).toMatch(
      /\| Avunu\/c \| expected failure \(check\): links to a file outside the repository \|/,
    );
    expect(text).toMatch(
      /\| Avunu\/d \| pass \(listed as an expected failure: remove the entry\): was broken once/,
    );
    expect(
      text
        .trim()
        .split("\n")
        .filter((l) => l.startsWith("| Avunu/")),
    ).toHaveLength(4);
  });
});

describe("the command line", () => {
  it("has defaults: the repository's fleet files, four at a time, GitHub", () => {
    const o = fleet.parseOptions([]);
    expect(o.fleet).toBe(join(REPO_ROOT, "fleet.json"));
    expect(o.expected).toBe(join(REPO_ROOT, "fleet.expected-failures.json"));
    expect(o).toMatchObject({
      concurrency: 4,
      cloneBase: "https://github.com",
      enforce: false,
      repos: [],
      list: false,
    });
  });

  it("takes repositories, a tarball and a clone base without a trailing slash", () => {
    const o = fleet.parseOptions([
      "--repo",
      "Avunu/a",
      "--repo",
      "Avunu/b",
      "--tarball",
      "x.tgz",
      "--clone-base",
      "file:///r/",
      "--enforce",
    ]);
    expect(o.repos).toEqual(["Avunu/a", "Avunu/b"]);
    expect(o.tarball).toBe(join(process.cwd(), "x.tgz"));
    expect(o.cloneBase).toBe("file:///r");
    expect(o.enforce).toBe(true);
  });

  it("enforces by itself on a release pull request, and only there, unless told otherwise", () => {
    expect(
      fleet.parseOptions([], { GITHUB_HEAD_REF: "release-please--branches--main" }).enforce,
    ).toBe(true);
    expect(
      fleet.parseOptions([], { GITHUB_REF_NAME: "release-please--branches--main" }).enforce,
    ).toBe(true);
    expect(fleet.parseOptions([], { GITHUB_REF_NAME: "main" }).enforce).toBe(false);
    expect(
      fleet.parseOptions([], { GITHUB_HEAD_REF: "feat/x", GITHUB_REF_NAME: "123/merge" }).enforce,
    ).toBe(false);
    expect(fleet.parseOptions([], {}).enforce).toBe(false);
    expect(
      fleet.parseOptions(["--informational"], { GITHUB_REF_NAME: "release-please--branches--main" })
        .enforce,
    ).toBe(false);
    expect(fleet.parseOptions(["--enforce"], {}).enforce).toBe(true);
    expect(fleet.parseOptions(["--enforce", "--informational"]).error).toMatch(
      /exclude each other/,
    );
  });

  it.each([["0"], ["33"], ["1.5"], ["x"]])("refuses --concurrency %s", (value) => {
    expect(fleet.parseOptions(["--concurrency", value]).error).toMatch(
      /--concurrency must be a whole number from 1 to 32/,
    );
  });

  it("refuses an unknown option, and lists the fleet on --list", () => {
    expect(fleet.parseOptions(["--nope"]).error).toMatch(/Unknown option/);
    const run = runScript("fleet.mjs", ["--list"]);
    expect(run.code).toBe(0);
    expect(run.stdout.trim().split("\n")).toHaveLength(21);
    expect(run.stdout).toContain("Avunu/frappe-nix\n");
  });

  it("exits 2 for a repository that is not in the fleet, an unreadable fleet and a missing tarball", () => {
    expect(runScript("fleet.mjs", ["--repo", "Avunu/not-there"]).output).toMatch(
      /Avunu\/not-there is not in/,
    );
    expect(runScript("fleet.mjs", ["--repo", "Avunu/not-there"]).code).toBe(2);
    expect(runScript("fleet.mjs", ["--fleet", "/nonexistent.json"]).code).toBe(2);
    const run = runScript("fleet.mjs", [
      "--repo",
      "Avunu/frappe-nix",
      "--tarball",
      "/nonexistent.tgz",
    ]);
    expect(run.code).toBe(2);
    expect(run.output).toMatch(/does not exist/);
  });
});

describe("a copy of the starter", () => {
  const starter: TreeSpec = {
    "docs-site/package.json": JSON.stringify({
      name: "x-docs",
      scripts: { postinstall: "x" },
      dependencies: { "@jxsuite/compiler": "5.0.0" },
    }),
    "docs-site/project.json": "{}",
    ".github/workflows/docs.yml": "name: Docs\n",
    ".github/workflows/check.yml": "name: Check\n",
    "docs/README.md": "# Docs\n",
  };

  it("is removed, with its workflow, before adoption", () => {
    const root = writeTree(tempDir(), starter);
    expect(fleet.removeStarter(root)).toEqual(["docs-site", ".github/workflows/docs.yml"]);
    expect(readFileSync(join(root, ".github", "workflows", "check.yml"), "utf8")).toBe(
      "name: Check\n",
    );
    expect(() => readFileSync(join(root, "docs-site", "package.json"))).toThrow();
    expect(readFileSync(join(root, "docs", "README.md"), "utf8")).toBe("# Docs\n");
  });

  it("is recognized by a postinstall script alone, as init recognizes it", () => {
    const root = writeTree(tempDir(), {
      ...starter,
      "docs-site/package.json": JSON.stringify({ scripts: { postinstall: "jx schema" } }),
    });
    expect(fleet.removeStarter(root)).toContain("docs-site");
  });

  it("is not confused with a thin shell, an unreadable package.json or no docs-site at all", () => {
    const thin = writeTree(tempDir(), {
      "docs-site/package.json": JSON.stringify({ dependencies: { "@avunu/docusystem": "^0.1.0" } }),
      ".github/workflows/docs.yml": "x",
    });
    expect(fleet.removeStarter(thin)).toEqual([]);
    expect(readFileSync(join(thin, ".github", "workflows", "docs.yml"), "utf8")).toBe("x");
    expect(fleet.removeStarter(writeTree(tempDir(), { "docs-site/package.json": "{" }))).toEqual(
      [],
    );
    expect(fleet.removeStarter(writeTree(tempDir(), { "README.md": "x" }))).toEqual([]);
  });
});

describe("a run against local repositories with a stand-in package", () => {
  let tarball: string;
  let base: string;

  /** A bare repository at <base>/Avunu/<name>.git whose default branch has `files`. */
  const remote = (name: string, files: TreeSpec): void => {
    const work = writeTree(suiteDir("docusystem-fleet-work-"), files);
    initRepo(work);
    git(work, "add", "-A");
    git(work, "commit", "-m", "the repository");
    const bare = join(base, "Avunu", `${name}.git`);
    mkdirSync(bare, { recursive: true });
    git(bare, "init", "--bare", "--initial-branch", "main");
    git(work, "push", bare, "main");
  };

  beforeAll(() => {
    tarball = pack(
      join(REPO_ROOT, "test", "e2e", "fixtures", "stub-cli"),
      suiteDir("docusystem-stub-pack-"),
    );
    base = suiteDir("docusystem-fleet-remotes-");
    remote("good", { "README.md": "# Good\n\nA project.\n" });
    remote("broken", { "README.md": "# Broken\n\nFAILCHECK\n" });
    remote("no-readme", { LICENSE: "MIT\n" });
    remote("old-starter", {
      "README.md": "# Old\n",
      "docs/README.md": "# Old docs\n",
      "docs-site/package.json": JSON.stringify({ dependencies: { "@jxsuite/compiler": "5.0.0" } }),
      ".github/workflows/docs.yml": "name: Docs\n",
    });
  });

  const fleetFile = (names: string[], extra: Record<string, unknown> = {}) =>
    write(
      tempDir(),
      "fleet.json",
      names.map((n) => ({ repo: `Avunu/${n}`, ...(extra[n] as object | undefined) })),
    );

  const runFleet = (names: string[], expected: Record<string, string>, ...args: string[]) => {
    const dir = tempDir("docusystem-fleet-run-");
    const summary = join(dir, "summary.md");
    const result = join(dir, "result.json");
    const run = runScript("fleet.mjs", [
      ...["--fleet", fleetFile(names), "--expected", write(dir, "expected.json", expected)],
      ...[
        "--tarball",
        tarball,
        "--clone-base",
        `file://${base}`,
        "--summary",
        summary,
        "--json",
        result,
      ],
      ...["--concurrency", "2", ...args],
    ]);
    const rows = (() => {
      try {
        return JSON.parse(readFileSync(result, "utf8")) as Row[];
      } catch {
        return [] as Row[];
      }
    })();
    return {
      run,
      rows,
      by: Object.fromEntries(rows.map((r) => [r.repo, r])) as Record<string, Row>,
      summary,
    };
  };

  it("adopts each repository: pass, a failed check, a failed init, and a copy of the starter replaced", () => {
    const { run, by, summary } = runFleet(["good", "broken", "no-readme", "old-starter"], {});
    expect(run.code, run.output).toBe(0); // informational: never fails the job
    expect(by["Avunu/good"]).toMatchObject({
      ok: true,
      stage: "done",
      outcome: "pass",
      removed: [],
    });
    expect(by["Avunu/broken"]).toMatchObject({ ok: false, stage: "check", outcome: "regression" });
    expect(by["Avunu/broken"]!.lines.join("\n")).toMatch(
      /lint: error docs\/README\.md:3 a broken link/,
    );
    expect(by["Avunu/no-readme"]).toMatchObject({ ok: false, stage: "init" });
    expect(by["Avunu/no-readme"]!.lines.join("\n")).toMatch(/docs\/ has no README\.md/);
    expect(by["Avunu/old-starter"]).toMatchObject({
      ok: true,
      removed: ["docs-site", ".github/workflows/docs.yml"],
    });
    expect(run.stdout).toMatch(/2 of 4 repositories pass\./);
    expect(readFileSync(summary, "utf8")).toMatch(/\| Avunu\/broken \| fail \(check\) \|/);
  });

  it("runs only the repositories it is asked for", () => {
    const { by } = runFleet(["good", "broken"], {}, "--repo", "Avunu/good");
    expect(Object.keys(by)).toEqual(["Avunu/good"]);
  });

  it("with --enforce, fails on a repository that fails and is not expected to", () => {
    const { run } = runFleet(["good", "broken"], {}, "--enforce");
    expect(run.code).toBe(1);
    expect(run.stderr).toMatch(/1 repository fail and is not expected to: Avunu\/broken/);
  });

  it("with --enforce, accepts a failure that is named with a reason", () => {
    const { run, by } = runFleet(
      ["good", "broken"],
      { "Avunu/broken": "its README is a stub" },
      "--enforce",
    );
    expect(run.code, run.output).toBe(0);
    expect(by["Avunu/broken"]).toMatchObject({
      outcome: "expected",
      reason: "its README is a stub",
    });
    expect(run.stdout).toMatch(/expected failure \(check\): its README is a stub/);
  });

  it("reports an expected failure that passes now, and does not fail on it", () => {
    const { run, by } = runFleet(["good"], { "Avunu/good": "it used to fail" }, "--enforce");
    expect(run.code, run.output).toBe(0);
    expect(by["Avunu/good"]!.outcome).toBe("fixed");
    expect(run.stdout).toMatch(/Avunu\/good passes now: remove it from the expected failures/);
  });

  it("clones without a token or a credential helper", () => {
    const source = readFileSync(join(REPO_ROOT, "scripts", "fleet.mjs"), "utf8");
    expect(source).toContain('GIT_CONFIG_GLOBAL: "/dev/null"');
    expect(source).toContain('GIT_TERMINAL_PROMPT: "0"');
    expect(source).toMatch(/"GITHUB_TOKEN",\s*"GH_TOKEN"/);
  });
});
