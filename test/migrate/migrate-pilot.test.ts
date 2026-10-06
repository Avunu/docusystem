import { existsSync, lstatSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { copyPilotGithub } from "../init/support/shell.js";
import { listTree, tempDir, writeTree } from "../support/index.js";
import {
  IDENTITY,
  PILOT_NAMES,
  SHA,
  STARTER,
  makeClone,
  migrate,
  sha256,
  srcHelpers,
  starterClone,
  syntheticLegacy,
  type Helpers,
  type Legacy,
  type MigrateScript,
  type Plan,
} from "./support.js";

// scripts/migrate-pilot.mjs on a synthetic clone of a repository that carries a copy of the starter: the
// delete-by-hash rule (a changed starter file is kept and listed), the conversions from Bun to npm, what
// is written and what is not, and that running it again changes nothing. The real starter (83 hashes) and
// the three real pilots are exercised by scripts/rehearse-pilots.mjs.

let m: MigrateScript;
let helpers: Helpers;
let legacy: Legacy;

beforeAll(async () => {
  m = await migrate();
  helpers = await srcHelpers();
  legacy = await syntheticLegacy();
});

const plan = (clone: string, o: { sha?: string; version?: string; siteDir?: string } = {}): Plan =>
  m.planMigration(clone, { helpers, legacy, sha: SHA, version: "0.1.0", ...o });

const paths = (p: Plan, kind: "delete" | "update" | "create"): string[] =>
  p.actions.filter((a) => a.kind === kind).map((a) => a.path);

const text = (clone: string, path: string): string =>
  readFileSync(join(clone, ...path.split("/")), "utf8");

const action = (p: Plan, path: string) => p.actions.find((a) => a.path === path);

describe("the plan", () => {
  test("lists what section 10.4 says and writes nothing", () => {
    const clone = makeClone();
    const before = listTree(clone);
    const p = plan(clone);
    expect(p.errors).toEqual([]);
    expect(paths(p, "delete")).toEqual([
      "docs-site/README.md",
      "docs-site/bun.lock",
      "docs-site/components/docs-callout.json",
      "docs-site/components/docs-footer.json",
      "docs-site/data/projects.snapshot.json",
      "docs-site/docs.config.json",
      "docs-site/layouts/base.json",
      "docs-site/project.json",
      "docs-site/public/.nojekyll",
      "docs-site/public/CNAME",
      "docs-site/public/favicon.svg",
      "docs-site/scripts/build.ts",
      "docs-site/scripts/lib/stage.ts",
    ]);
    expect(paths(p, "update")).toEqual([
      ".github/dependabot.yml",
      ".github/workflows/dependabot-auto-merge.yml",
      ".github/workflows/docs.yml",
      "docs-site/.gitignore",
      "docs-site/package.json",
    ]);
    expect(paths(p, "create")).toEqual([
      ".github/workflows/docs-publish.yml",
      "docs-site/docusystem.config.json",
    ]);
    expect(p.kept).toEqual([]);
    expect(m.summarize(p)).toEqual({ delete: 13, update: 5, create: 2, kept: 0 });
    expect(listTree(clone)).toEqual(before);
  });

  test("is sorted by path and the report names every file once", () => {
    const p = plan(makeClone());
    const sorted = [...p.actions.map((a) => a.path)].sort();
    expect(p.actions.map((a) => a.path)).toEqual(sorted);
    const report = m.formatPlan(p, { write: false });
    for (const a of p.actions) {
      expect(
        report.filter((line) => line.startsWith(`  ${a.kind.padEnd(6)}  ${a.path} `)),
      ).toHaveLength(1);
    }
    expect(report.join("\n")).toContain("13 to delete, 5 to update, 2 to create");
    expect(report.join("\n")).toContain("dry run: nothing is written");
  });

  test("a dry run without a commit shows the placeholder and says what --write needs", () => {
    const p = m.planMigration(makeClone(), { helpers, legacy, version: "0.1.0" });
    expect(p.shaGiven).toBe(false);
    expect(p.sha).toBe(m.PLACEHOLDER_SHA);
    expect(p.advice.join("\n")).toContain("--write needs --workflow-sha");
    expect(p.advice.join("\n")).toContain("refs/tags/v0.1.0");
  });

  test("a plan with an error says so, and does not claim there is nothing to do", () => {
    const report = m.formatPlan(plan(tempDir("docusystem-migrate-")), { write: true }).join("\n");
    expect(report).toContain("the plan has an error: nothing is written");
    expect(report).toContain("has no .git");
    expect(report).not.toContain("applying the plan");
    expect(report).not.toContain("Nothing to do");
  });

  test("is refused for a folder that is not a clone, has no site folder or no starter", () => {
    const noGit = tempDir("docusystem-migrate-");
    expect(plan(noGit).errors[0]).toContain("has no .git");
    const noSite = makeClone({ ".keep": "" });
    expect(plan(noSite).errors[0]).toContain("docs-site/ does not exist");
    const noConfig = makeClone(starterClone({ files: { "docs-site/docs.config.json": null } }));
    expect(plan(noConfig).errors[0]).toContain("neither docs.config.json");
    expect(plan(join(noGit, "missing")).errors[0]).toContain("is not a folder");
  });

  test("takes another site folder", () => {
    const spec: Record<string, string> = {};
    for (const [path, body] of Object.entries(starterClone())) {
      if (typeof body === "string") spec[path.replace(/^docs-site\//, "website/")] = body;
    }
    const clone = makeClone(spec);
    const p = plan(clone, { siteDir: "website" });
    expect(p.errors).toEqual([]);
    expect(paths(p, "create")).toContain("website/docusystem.config.json");
    expect(action(p, ".github/workflows/docs.yml")?.after).toContain("site-directory: website");
    expect(plan(clone, { siteDir: "../x" }).errors[0]).toContain("not a usable site folder");
  });
});

describe("the starter's files (step 1)", () => {
  test("a starter file that was changed is kept and listed, never deleted", () => {
    const clone = makeClone(
      starterClone({
        files: {
          "docs-site/components/docs-footer.json": '{ "tagName": "docs-footer", "x": 1 }\n',
        },
      }),
    );
    const p = plan(clone);
    expect(paths(p, "delete")).not.toContain("docs-site/components/docs-footer.json");
    expect(p.kept).toEqual([
      {
        path: "docs-site/components/docs-footer.json",
        why: expect.stringContaining("a file of the starter that has been changed"),
      },
    ]);
    m.applyPlan(p, helpers);
    expect(text(clone, "docs-site/components/docs-footer.json")).toContain('"x": 1');
    expect(existsSync(join(clone, "docs-site/components/docs-callout.json"))).toBe(false);
  });

  test("a file the starter never had is kept and listed; a copy of a starter file elsewhere is not the starter's", () => {
    const clone = makeClone(
      starterClone({
        files: {
          "docs-site/notes.txt": "mine\n",
          "docs-site/components/copy.json": STARTER["components/docs-callout.json"]!,
          "docs-site/public/og.png": "png",
        },
      }),
    );
    const p = plan(clone);
    expect(Object.fromEntries(p.kept.map((k) => [k.path, k.why]))).toEqual({
      "docs-site/components/copy.json": expect.stringContaining("not a starter file"),
      "docs-site/notes.txt": expect.stringContaining("not a starter file"),
      "docs-site/public/og.png": expect.stringContaining("public/ and overrides/ are the shell's"),
    });
    m.applyPlan(p, helpers);
    expect(listTree(join(clone, "docs-site"))).toEqual([
      ".gitignore",
      "components/",
      "components/copy.json",
      "docusystem.config.json",
      "notes.txt",
      "package.json",
      "public/",
      "public/og.png",
    ]);
  });

  test("a starter file with the starter's bytes is deleted only at the starter's path", () => {
    const clone = makeClone(
      starterClone({
        files: {
          "docs-site/layouts/base.json": null,
          "docs-site/pages/base.json": STARTER["layouts/base.json"]!,
        },
      }),
    );
    const p = plan(clone);
    expect(paths(p, "delete")).not.toContain("docs-site/pages/base.json");
    expect(p.kept.map((k) => k.path)).toEqual(["docs-site/pages/base.json"]);
  });

  test("a symbolic link is left alone and listed", () => {
    const clone = makeClone(starterClone({ files: { "docs-site/README.md": null } }));
    const outside = tempDir("docusystem-outside-");
    writeTree(outside, { "README.md": "outside\n" });
    symlinkSync(join(outside, "README.md"), join(clone, "docs-site", "README.md"));
    const p = plan(clone);
    expect(p.kept).toEqual([{ path: "docs-site/README.md", why: "a symbolic link: not touched" }]);
    m.applyPlan(p, helpers);
    expect(lstatSync(join(clone, "docs-site", "README.md")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(outside, "README.md"), "utf8")).toBe("outside\n");
  });

  test("a starter file below a symbolic link is refused, and the file the link leads to is not touched", () => {
    const outside = tempDir("docusystem-outside-");
    writeTree(outside, { "docs-callout.json": STARTER["components/docs-callout.json"]! });
    const clone = makeClone(
      starterClone({
        files: {
          "docs-site/components/docs-callout.json": null,
          "docs-site/components/docs-footer.json": null,
        },
      }),
    );
    symlinkSync(outside, join(clone, "docs-site", "components"));
    const p = plan(clone);
    expect(p.errors.join("\n")).toContain("components is a symbolic link");
    expect(() => m.applyPlan(p, helpers)).toThrow("the plan has errors");
    expect(readFileSync(join(outside, "docs-callout.json"), "utf8")).toBe(
      STARTER["components/docs-callout.json"],
    );
  });

  test("the Bun lockfile goes, whichever form it has", () => {
    const clone = makeClone(starterClone({ files: { "docs-site/bun.lockb": "binary" } }));
    const p = plan(clone);
    expect(paths(p, "delete")).toEqual(
      expect.arrayContaining(["docs-site/bun.lock", "docs-site/bun.lockb"]),
    );
  });
});

describe("project.json and public/CNAME (step 1)", () => {
  test("project.json is deleted when only name and url differ from the starter's, however it is formatted", () => {
    const p = plan(makeClone());
    expect(action(p, "docs-site/project.json")?.why).toContain("apart from name and url");
  });

  test("a project.json that differs in anything else is kept and listed", () => {
    const clone = makeClone(
      starterClone({
        files: {
          "docs-site/project.json": JSON.stringify({
            name: "X",
            url: "https://x.avunu.net",
            defaults: { layout: "./layouts/base.json" },
            extensions: ["@jxsuite/parser", "@jxsuite/search", "mine"],
          }),
        },
      }),
    );
    const p = plan(clone);
    expect(paths(p, "delete")).not.toContain("docs-site/project.json");
    expect(p.kept).toEqual([
      { path: "docs-site/project.json", why: expect.stringContaining("beyond name and url") },
    ]);
  });

  test("a project.json that is not JSON is kept and listed", () => {
    const clone = makeClone(starterClone({ files: { "docs-site/project.json": "{ nope" } }));
    expect(plan(clone).kept[0]?.why).toContain("not valid JSON");
  });

  test("CNAME goes when it holds the configured domain", () => {
    expect(action(plan(makeClone()), "docs-site/public/CNAME")?.kind).toBe("delete");
  });

  test("a CNAME that holds another host is kept, and the advice says it must go", () => {
    const clone = makeClone(
      starterClone({ files: { "docs-site/public/CNAME": "other.example.org\n" } }),
    );
    const p = plan(clone);
    expect(paths(p, "delete")).not.toContain("docs-site/public/CNAME");
    expect(p.kept[0]?.why).toContain('holds "other.example.org"');
    expect(p.advice.join("\n")).toContain("refuses a supplied one");
  });
});

describe("the configuration (step 2)", () => {
  test("docs.config.json becomes docusystem.config.json: the same values, $schema first", () => {
    const clone = makeClone();
    const p = plan(clone);
    const created = action(p, "docs-site/docusystem.config.json");
    expect(created?.kind).toBe("create");
    expect(JSON.parse(created?.after ?? "")).toEqual({
      $schema: "./node_modules/@avunu/docusystem/config.schema.json",
      ...IDENTITY,
    });
    expect(Object.keys(JSON.parse(created?.after ?? ""))).toEqual([
      "$schema",
      "name",
      "tagline",
      "slug",
      "platform",
      "repo",
      "domain",
      "license",
    ]);
    expect(action(p, "docs-site/docs.config.json")?.kind).toBe("delete");
    expect(created?.after?.endsWith("}\n")).toBe(true);
  });

  test("optional keys are kept in the order of the schema, and a key init does not know is an error", () => {
    const withExtras = { ...IDENTITY, branch: "develop", images: "off" };
    const clone = makeClone(
      starterClone({ files: { "docs-site/docs.config.json": JSON.stringify(withExtras) } }),
    );
    const created = action(plan(clone), "docs-site/docusystem.config.json");
    expect(Object.keys(JSON.parse(created?.after ?? "")).slice(-2)).toEqual(["branch", "images"]);

    const typo = makeClone(
      starterClone({
        files: { "docs-site/docs.config.json": JSON.stringify({ ...IDENTITY, tagLine: "x" }) },
      }),
    );
    expect(plan(typo).errors.join("\n")).toContain("tagLine");
  });

  test("a configuration that is not valid is an error, and nothing is written", () => {
    const clone = makeClone(
      starterClone({
        files: {
          "docs-site/docs.config.json": JSON.stringify({ ...IDENTITY, domain: "not a host" }),
        },
      }),
    );
    const before = listTree(clone);
    const p = plan(clone);
    expect(p.errors.join("\n")).toContain("docusystem.config.json");
    expect(p.errors.join("\n")).toContain("domain");
    expect(() => m.applyPlan(p, helpers)).toThrow("the plan has errors");
    expect(listTree(clone)).toEqual(before);
    expect(m.formatPlan(p).join("\n")).toContain("Errors");
  });

  test("a configuration that is not JSON is an error", () => {
    const clone = makeClone(starterClone({ files: { "docs-site/docs.config.json": "{" } }));
    expect(plan(clone).errors[0]).toContain("is not valid JSON");
  });

  test("an existing docusystem.config.json wins and is not rewritten; two that differ are an error", () => {
    const only = makeClone(
      starterClone({
        files: {
          "docs-site/docs.config.json": null,
          "docs-site/docusystem.config.json": JSON.stringify(IDENTITY),
        },
      }),
    );
    const p = plan(only);
    expect(p.errors).toEqual([]);
    expect(p.actions.map((a) => a.path)).not.toContain("docs-site/docusystem.config.json");

    const both = makeClone(
      starterClone({
        files: {
          "docs-site/docusystem.config.json": JSON.stringify({ ...IDENTITY, name: "Other" }),
        },
      }),
    );
    expect(plan(both).errors[0]).toContain("both exist and differ");

    const same = makeClone(
      starterClone({
        files: {
          "docs-site/docusystem.config.json": JSON.stringify({ $schema: "x", ...IDENTITY }),
        },
      }),
    );
    const q = plan(same);
    expect(q.errors).toEqual([]);
    expect(action(q, "docs-site/docs.config.json")?.kind).toBe("delete");
  });
});

describe("package.json, .gitignore and the callers (step 3)", () => {
  test("package.json is the shell's: one dependency, three scripts, the name from the slug with hyphens", () => {
    const p = plan(makeClone());
    const pkg = action(p, "docs-site/package.json");
    expect(pkg?.why).toContain("apart from its name");
    expect(JSON.parse(pkg?.after ?? "")).toEqual({
      name: "frappe-nix-docs",
      private: true,
      type: "module",
      scripts: { dev: "docusystem dev", build: "docusystem build", check: "docusystem check" },
      dependencies: { "@avunu/docusystem": "^0.1.0" },
    });
    expect(Object.keys(JSON.parse(pkg?.after ?? ""))).toEqual([
      "name",
      "private",
      "type",
      "scripts",
      "dependencies",
    ]);
  });

  test("the range follows the version, or --range", () => {
    expect(m.rangeFor("0.1.7")).toBe("^0.1.0");
    expect(m.rangeFor("1.4.2")).toBe("^1.4.0");
    const p = m.planMigration(makeClone(), {
      helpers,
      legacy,
      sha: SHA,
      version: "0.3.1",
      range: "~0.3.1",
    });
    expect(JSON.parse(action(p, "docs-site/package.json")?.after ?? "").dependencies).toEqual({
      "@avunu/docusystem": "~0.3.1",
    });
  });

  test("a package.json that differs from the starter's beyond its name is replaced, and the note says so", () => {
    const pkg = JSON.parse(STARTER["package.json"]!);
    pkg.dependencies.extra = "^1.0.0";
    const clone = makeClone(
      starterClone({ files: { "docs-site/package.json": JSON.stringify(pkg) } }),
    );
    const p = plan(clone);
    expect(action(p, "docs-site/package.json")?.why).toContain(
      "differs from the starter's beyond its name",
    );
    expect(action(p, "docs-site/package.json")?.before).toContain('"extra"');
  });

  test("a package.json that is already the shell's is left alone, whatever its range", () => {
    const shell = JSON.stringify({
      name: "frappe-nix-docs",
      private: true,
      dependencies: { "@avunu/docusystem": "^0.2.0" },
    });
    const clone = makeClone(starterClone({ files: { "docs-site/package.json": shell } }));
    expect(plan(clone).actions.map((a) => a.path)).not.toContain("docs-site/package.json");
  });

  test("the starter's .gitignore is replaced by the shell's three lines; another one gets the missing lines", () => {
    const p = plan(makeClone());
    expect(action(p, "docs-site/.gitignore")?.after).toBe("node_modules/\ndist/\n.docusystem/\n");

    const mine = makeClone(
      starterClone({ files: { "docs-site/.gitignore": "node_modules/\n*.log" } }),
    );
    const q = plan(mine);
    expect(action(q, "docs-site/.gitignore")?.after).toBe(
      "node_modules/\n*.log\ndist/\n.docusystem/\n",
    );

    const complete = makeClone(
      starterClone({ files: { "docs-site/.gitignore": "/dist\nnode_modules\n.docusystem/\n" } }),
    );
    expect(plan(complete).actions.map((a) => a.path)).not.toContain("docs-site/.gitignore");
  });

  test("what the starter's postinstall and build left behind is removed when its .gitignore listed it", () => {
    const clone = makeClone(
      starterClone({
        files: {
          "docs-site/project.schema.json": "{}",
          "docs-site/document.schema.json": "{}",
          "docs-site/.generated/nav.json": "{}",
          "docs-site/dist/index.html": "built",
          "docs-site/node_modules/x/index.js": "installed",
        },
      }),
    );
    const p = plan(clone);
    expect(paths(p, "delete")).toEqual(
      expect.arrayContaining([
        "docs-site/.generated",
        "docs-site/document.schema.json",
        "docs-site/project.schema.json",
      ]),
    );
    expect(p.advice.join("\n")).toContain("node_modules exists");
    m.applyPlan(p, helpers);
    // dist/ and node_modules/ are git-ignored by the shell too: they are not touched
    expect(existsSync(join(clone, "docs-site", "dist", "index.html"))).toBe(true);
    expect(existsSync(join(clone, "docs-site", "node_modules", "x", "index.js"))).toBe(true);
    expect(existsSync(join(clone, "docs-site", ".generated"))).toBe(false);
  });

  test("the callers are the scaffold, pinned to the commit and version, replacing the starter's workflow", () => {
    const p = plan(makeClone());
    const docs = action(p, ".github/workflows/docs.yml");
    expect(docs?.kind).toBe("update");
    expect(docs?.why).toContain("the starter's 3-line workflow");
    expect(docs?.after).toBe(
      (helpers.renderScaffold as (...a: unknown[]) => string)("docs.yml", {
        docs: "docs",
        site: "docs-site",
        sha: SHA,
        version: "0.1.0",
      }),
    );
    expect(docs?.after).toContain(`docs-build.yml@${SHA} # v0.1.0`);
    const publish = action(p, ".github/workflows/docs-publish.yml");
    expect(publish?.kind).toBe("create");
    expect(publish?.after).toContain(`docs-deploy.yml@${SHA} # v0.1.0`);
    expect(publish?.after).toContain("pages-artifact: ${{ vars.DOCS_SITE_ENABLED == 'true' }}");
  });

  test("a workflow that is not the starter's is replaced too, and the note says it is not the starter's", () => {
    const clone = makeClone(
      starterClone({ files: { ".github/workflows/docs.yml": "name: Mine\non: push\n" } }),
    );
    expect(action(plan(clone), ".github/workflows/docs.yml")?.why).toContain(
      "it is not the starter's",
    );
  });

  test("a docs folder elsewhere reaches the path filters", () => {
    const clone = makeClone(
      starterClone({
        files: {
          "docs-site/docs.config.json": JSON.stringify({ ...IDENTITY, docs: "../documentation" }),
          "docs/README.md": null,
          "documentation/README.md": "# Home\n",
        },
      }),
    );
    expect(action(plan(clone), ".github/workflows/docs.yml")?.after).toContain(
      "      - documentation/**\n",
    );
    const outside = makeClone(
      starterClone({
        files: {
          "docs-site/docs.config.json": JSON.stringify({ ...IDENTITY, docs: "../../outside" }),
        },
      }),
    );
    expect(plan(outside).errors.join("\n")).toContain("outside the repository");
  });
});

describe("Dependabot and the auto-merge workflow (steps 4 and 5)", () => {
  test("the Bun entry becomes an npm entry in place: a one-line diff", () => {
    const clone = makeClone();
    const p = plan(clone);
    const dependabot = action(p, ".github/dependabot.yml");
    expect(dependabot?.why).toBe("converted the bun entry for /docs-site to npm");
    const before = (dependabot?.before ?? "").split("\n");
    const after = (dependabot?.after ?? "").split("\n");
    expect(after.length).toBe(before.length);
    const changed = after.flatMap((line, i) => (line === before[i] ? [] : [[before[i], line]]));
    expect(changed).toEqual([["  - package-ecosystem: bun", "  - package-ecosystem: npm"]]);
  });

  test.each(PILOT_NAMES)(
    "on the real file of %s: the entry is converted and keeps the package out of its cooldown, no second github-actions entry",
    (pilot) => {
      const clone = makeClone(starterClone());
      copyPilotGithub(clone, pilot);
      const p = plan(clone);
      const dependabot = action(p, ".github/dependabot.yml");
      const before = (dependabot?.before ?? "").split("\n");
      const after = (dependabot?.after ?? "").split("\n");
      // the exclude list is two lines; the ecosystem line and a comment that named Bun are the others
      expect(after.length).toBe(before.length + 2);
      expect(dependabot?.after).toContain(
        '      default-days: 7\n      exclude:\n        - "@avunu/docusystem"\n',
      );
      expect(dependabot?.after).not.toContain("package-ecosystem: bun");
      expect(dependabot?.after).not.toMatch(/\bBun\b/);
      expect((dependabot?.after ?? "").match(/package-ecosystem: github-actions/g)).toHaveLength(1);
      expect(dependabot?.why).toContain(
        "excluded @avunu/docusystem from the cooldown of the npm entry for /docs-site",
      );
      const merge = action(p, ".github/workflows/dependabot-auto-merge.yml");
      expect(merge?.after).toContain("dependabot/npm_and_yarn/docs-site");
      expect(merge?.after).not.toContain("dependabot/bun/docs-site");
      expect(merge?.after).not.toContain("gated by a repository variable");
      const lines = (merge?.after ?? "").split("\n").length;
      expect(lines).toBe((merge?.before ?? "").split("\n").length);
    },
  );

  test("what init could not do about a cooldown is advised: the github-actions entry, an npm entry that was there, a Bun comment about something else", () => {
    const clone = makeClone(starterClone());
    copyPilotGithub(clone, "erpnext_taskview");
    const advice = plan(clone).advice.join("\n");
    expect(advice).toContain(
      "the github-actions entry has a cooldown that does not exclude Avunu/docusystem",
    );
    // the converted entry excludes the package and its comments are reworded: nothing to say
    expect(advice).not.toContain("the npm entry for /docs-site");
    expect(advice).not.toContain('"Bun" in a comment');

    const own = makeClone(
      starterClone({
        dependabot: [
          "version: 2",
          "updates:",
          "  # The mobile app is built with Bun.",
          "  - package-ecosystem: npm",
          "    directory: /docs-site",
          "    cooldown:",
          "      default-days: 7",
          "",
        ].join("\n"),
      }),
    );
    const ownAdvice = plan(own).advice.join("\n");
    expect(ownAdvice).toContain(
      'the npm entry for /docs-site has a cooldown that does not exclude "@avunu/docusystem"',
    );
    expect(ownAdvice).toContain('"Bun" in a comment');
  });

  test("a repository without a Dependabot file gets one with both entries", () => {
    const p = plan(makeClone(starterClone({ files: { ".github/dependabot.yml": null } })));
    const created = action(p, ".github/dependabot.yml");
    expect(created?.kind).toBe("create");
    expect(created?.after).toContain("package-ecosystem: npm");
    expect(created?.after).toContain("package-ecosystem: github-actions");
  });

  test("a Dependabot file that cannot be edited safely is advice, with the snippet", () => {
    const clone = makeClone(starterClone({ dependabot: "version: 2\nupdates: not-a-list\n" }));
    const p = plan(clone);
    expect(p.errors).toEqual([]);
    expect(p.actions.map((a) => a.path)).not.toContain(".github/dependabot.yml");
    expect(p.advice.join("\n")).toContain("has an `updates` that is not a list");
    expect(p.advice.join("\n")).toContain("package-ecosystem: npm");
  });

  test("an auto-merge workflow of a shape init cannot patch is advice, and one that is not an auto-merge workflow is left alone", () => {
    const odd = [
      "name: Auto merge",
      "on: pull_request",
      "jobs:",
      "  merge:",
      `    if: "github.actor == 'dependabot[bot]' && github.event.pull_request.draft == false"`,
      "    runs-on: ubuntu-latest",
      '    steps:\n      - run: gh pr merge --auto "$PR"',
      "",
    ].join("\n");
    const clone = makeClone(
      starterClone({
        automerge: odd,
        files: { ".github/workflows/check.yml": "name: Check\non: push\n" },
      }),
    );
    const p = plan(clone);
    expect(p.actions.map((a) => a.path)).not.toContain(
      ".github/workflows/dependabot-auto-merge.yml",
    );
    expect(p.advice.join("\n")).toContain(
      "dependabot-auto-merge.yml: the condition of the job `merge` (line 5: `github.actor == 'dependabot[bot]' && github.event.pull_request.draft == false`) is a shape init does not rewrite",
    );
    expect(p.advice.join("\n")).toContain(
      "if: ${{ github.actor == 'dependabot[bot]' && github.event.pull_request.draft == false && !startsWith(github.head_ref, 'dependabot/npm_and_yarn/docs-site') && !startsWith(github.head_ref, 'dependabot/github_actions/') }}",
    );
    expect(p.actions.map((a) => a.path)).not.toContain(".github/workflows/check.yml");
  });
});

describe("what is listed, not changed (step 6)", () => {
  test("formatter and hook settings that mention the site folder are listed with their lines", () => {
    const clone = makeClone(
      starterClone({
        files: {
          ".pre-commit-config.yaml": "repos:\n  - id: oxlint\n    exclude: '^(docs|docs-site)/'\n",
          ".oxfmtrc.json": '{ "ignorePatterns": ["dist", "docs-site"] }\n',
          ".oxlintrc.json": '{ "ignorePatterns": ["dist"] }\n',
          "package.json": '{ "scripts": { "lint": "oxlint . --ignore-pattern docs-site/" } }\n',
          ".github/workflows/check.yml":
            "name: Check\non:\n  push:\n    paths-ignore: ['docs-site/**']\n",
        },
      }),
    );
    const p = plan(clone);
    expect(p.mentions.map((x) => x.file)).toEqual([
      ".github/workflows/check.yml",
      ".oxfmtrc.json",
      ".pre-commit-config.yaml",
      "package.json",
    ]);
    expect(p.mentions.find((x) => x.file === ".pre-commit-config.yaml")?.lines).toEqual([
      { line: 3, text: "exclude: '^(docs|docs-site)/'" },
    ]);
    expect(p.advice.join("\n")).toContain(
      "keep a docs/ exclusion for a hook that stamps a copyright comment",
    );
    // the auto-merge workflow names the site on purpose: not listed
    expect(p.mentions.map((x) => x.file)).not.toContain(
      ".github/workflows/dependabot-auto-merge.yml",
    );
    expect(m.formatPlan(p).join("\n")).toContain(".pre-commit-config.yaml:3:");
  });

  test("a name that merely contains the site folder's name is not a mention", () => {
    const clone = makeClone(
      starterClone({
        files: { ".oxfmtrc.json": '{ "ignore": ["my-docs-site-2", "x/docs-site"] }\n' },
      }),
    );
    expect(plan(clone).mentions).toEqual([]);
  });

  test("nothing is deleted that the plan does not list", () => {
    const clone = makeClone(
      starterClone({ files: { "docs-site/overrides/components/docs-footer.json": "{}" } }),
    );
    const p = plan(clone);
    m.applyPlan(p, helpers);
    expect(existsSync(join(clone, "docs-site/overrides/components/docs-footer.json"))).toBe(true);
    expect(existsSync(join(clone, "docs/README.md"))).toBe(true);
  });
});

describe("writing the plan", () => {
  test("applies it: the tree is the shell, and the emptied folders are gone", () => {
    const clone = makeClone();
    const p = plan(clone);
    m.applyPlan(p, helpers);
    expect(listTree(clone)).toEqual([
      ".git/",
      ".github/",
      ".github/dependabot.yml",
      ".github/workflows/",
      ".github/workflows/dependabot-auto-merge.yml",
      ".github/workflows/docs-publish.yml",
      ".github/workflows/docs.yml",
      "docs-site/",
      "docs-site/.gitignore",
      "docs-site/docusystem.config.json",
      "docs-site/package.json",
      "docs/",
      "docs/README.md",
    ]);
    expect(text(clone, ".github/dependabot.yml")).toContain("package-ecosystem: npm");
    expect(text(clone, ".github/dependabot.yml")).not.toContain("package-ecosystem: bun");
    expect(text(clone, ".github/workflows/dependabot-auto-merge.yml")).toContain(
      "!startsWith(github.head_ref, 'dependabot/npm_and_yarn/docs-site')",
    );
    expect(JSON.parse(text(clone, "docs-site/docusystem.config.json")).slug).toBe("frappe_nix");
    expect(text(clone, "docs-site/.gitignore")).toBe("node_modules/\ndist/\n.docusystem/\n");
  });

  test("running it again changes nothing, with the same arguments or with another commit", () => {
    const clone = makeClone();
    m.applyPlan(plan(clone), helpers);
    const once = listTree(clone);
    const contents = Object.fromEntries(
      once.filter((p) => !p.endsWith("/")).map((p) => [p, text(clone, p)]),
    );
    const again = plan(clone);
    expect(again.errors).toEqual([]);
    expect(again.actions).toEqual([]);
    expect(again.kept).toEqual([]);
    expect(m.formatPlan(again).join("\n")).toContain("Nothing to do");
    m.applyPlan(again, helpers);
    // a later release's pin is the business of `docusystem upgrade`, not of this tool
    const later = plan(clone, {
      sha: "fedcba9876543210fedcba9876543210fedcba98",
      version: "0.2.0",
    });
    expect(later.actions).toEqual([]);
    expect(listTree(clone)).toEqual(once);
    for (const [path, body] of Object.entries(contents)) expect(text(clone, path)).toBe(body);
  });

  test("a plan with an error writes nothing", () => {
    const clone = makeClone(
      starterClone({ files: { "docs-site/docs.config.json": JSON.stringify({ name: "x" }) } }),
    );
    const before = listTree(clone);
    expect(() => m.applyPlan(plan(clone), helpers)).toThrow("the plan has errors");
    expect(listTree(clone)).toEqual(before);
  });

  test("a path outside the clone is refused before anything is written", () => {
    const clone = makeClone();
    const before = listTree(clone);
    const p = plan(clone);
    const escaping: Plan = {
      ...p,
      actions: [
        ...p.actions,
        { kind: "create", path: "../escape.txt", why: "x", before: null, after: "x" },
      ],
    };
    expect(() => m.applyPlan(escaping, helpers)).toThrow("not inside");
    expect(listTree(clone)).toEqual(before);
  });

  test("--diff adds the text of every create and update", () => {
    const p = plan(makeClone());
    const lines = m.formatPlan(p, { diff: true, unifiedDiff: helpers.unifiedDiff as never });
    expect(lines).toContain("--- a/docs-site/package.json");
    expect(lines).toContain("+++ b/docs-site/package.json");
    expect(lines).toContain("--- /dev/null");
    expect(lines.join("\n")).not.toContain("--- a/docs-site/README.md");
  });
});

describe("the real starter's record", () => {
  test("starter-v0.json holds the 83 files of the template, sorted, with their sha256", () => {
    const real = m.loadLegacy();
    const names = Object.keys(real.files);
    expect(names).toHaveLength(83);
    expect(names).toEqual([...names].sort());
    for (const sha of Object.values(real.files)) expect(sha).toMatch(/^[0-9a-f]{64}$/);
    expect(names).toEqual(
      expect.arrayContaining([
        ".github/workflows/docs.yml",
        ".github/dependabot.yml",
        ".gitignore",
        "docs.config.json",
        "package.json",
        "project.json",
        "public/CNAME",
        "scripts/lib/stage.ts",
      ]),
    );
    expect(real.source).toMatchObject({
      repository: "Avunu/docs",
      branch: "feat/project-docs-starter",
      commit: "1820d01ccbd2a6a299f6f673381a2272a06c64dc",
    });
    expect(Object.keys(real.canonical)).toEqual(["package.json", "project.json"]);
    expect(real.canonical["project.json"]?.ignore).toEqual(["name", "url"]);
  });

  test("a record that is not usable is refused", () => {
    const dir = tempDir("docusystem-legacy-");
    const file = join(dir, "bad.json");
    writeTree(dir, { "bad.json": JSON.stringify({ files: { "a.txt": "nothex" } }) });
    expect(() => m.loadLegacy(file)).toThrow("has no sha256");
    writeTree(dir, { "worse.json": JSON.stringify({ files: { "a.txt": sha256("a") } }) });
    expect(() => m.loadLegacy(join(dir, "worse.json"))).toThrow('"canonical" has no usable entry');
  });
});

describe("the command line", () => {
  test("--write needs the commit of the release tag, because the tool runs no git", () => {
    const r = m.parseOptions(["/clone", "--write"]);
    expect(r.error).toContain("--write needs --workflow-sha");
    expect(m.parseOptions(["/clone", "--write", "--workflow-sha", SHA])).toMatchObject({
      clone: "/clone",
      write: true,
      sha: SHA,
    });
  });

  test("a dry run needs nothing but the clone; every option is validated", () => {
    expect(m.parseOptions(["/clone"])).toMatchObject({ write: false, diff: false, json: false });
    expect(m.parseOptions([]).error).toContain("give the clone");
    expect(m.parseOptions(["a", "b"]).error).toContain("give the clone");
    expect(m.parseOptions(["/clone", "--workflow-sha", "abc"]).error).toContain("40-character");
    expect(m.parseOptions(["/clone", "--package-version", "one"]).error).toContain(
      "MAJOR.MINOR.PATCH",
    );
    expect(m.parseOptions(["/clone", "--nope"]).error).toBeDefined();
    expect(m.parseOptions(["--help"]).help).toBe(true);
    expect(m.parseOptions(["/clone", "--workflow-sha", SHA.toUpperCase()]).sha).toBe(SHA);
  });

  test("the helpers come from dist/, and a missing build says what to do", async () => {
    await expect(m.loadHelpers(tempDir("docusystem-nodist-"))).rejects.toThrow(
      "run `npm run build` first",
    );
  });

  test("a helper that the package does not export is named", () => {
    expect(() => m.pickHelpers({})).toThrow("do not export");
  });
});
