import { readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, test } from "vitest";
import { packageRoot } from "../../src/lib/package-info.js";
import {
  cleanSiteDir,
  docsPathProblem,
  folderGlob,
  inspectCaller,
  maintainerSteps,
  planChange,
  readScaffold,
  renderScaffold,
  siteDirProblem,
  unifiedDiff,
} from "../../src/lib/workflows.js";
import { readFixture } from "./support/fixtures.js";
import { SHA, SHA2 } from "./support/shell.js";

const VALUES = { docs: "docs", site: "docs-site", sha: SHA, version: "v0.1.0" };

describe("the scaffold", () => {
  test("is exactly the five files that init writes from", () => {
    expect(
      readdirSync(join(packageRoot, "scaffold"))
        .filter((f) => !f.startsWith("."))
        .sort(),
    ).toEqual([
      "dependabot-actions.yml",
      "dependabot-npm.yml",
      "docs-publish.yml",
      "docs.yml",
      "gitignore",
    ]);
  });

  test("renders, for the example's values, to the files of the example shell", () => {
    expect(renderScaffold("docs.yml", VALUES)).toBe(
      readFixture("example-shell", ".github", "workflows", "docs.yml"),
    );
    expect(renderScaffold("docs-publish.yml", VALUES)).toBe(
      readFixture("example-shell", ".github", "workflows", "docs-publish.yml"),
    );
  });

  test("the version may be given with or without its v", () => {
    expect(renderScaffold("docs.yml", { ...VALUES, version: "0.1.0" })).toBe(
      renderScaffold("docs.yml", VALUES),
    );
  });

  test("lists the paths of each caller one entry per line, which no formatter re-wraps", () => {
    // A one-line `paths: [...]` list is wider than 100 columns and is re-wrapped by oxfmt and prettier
    // (see formatter.test.ts), so the adoption pull request fails the repository's own format check.
    for (const file of ["docs.yml", "docs-publish.yml"] as const) {
      const text = readScaffold(file);
      expect(text, file).not.toMatch(/^\s*paths:\s*\[/m);
      expect(text, file).toMatch(
        /^ {4}paths:\n {6}- @@DOCS@@\/\*\*\n {6}- @@SITE@@\/\*\*\n {6}- \.github\/workflows\/docs\.yml\n {6}- \.github\/workflows\/docs-publish\.yml\n/m,
      );
    }
  });

  test("leaves no token behind", () => {
    for (const file of ["docs.yml", "docs-publish.yml"] as const) {
      expect(renderScaffold(file, VALUES)).not.toMatch(/@@/);
    }
  });

  test("a different site and docs folder reach the paths filter and the site-directory input", () => {
    const text = renderScaffold("docs.yml", {
      ...VALUES,
      docs: "documentation",
      site: "tools/docs-site",
    });
    const workflow = parse(text) as {
      on: { pull_request: { paths: string[] } };
      jobs: { build: { with: Record<string, string> } };
    };
    expect(workflow.on.pull_request.paths).toEqual([
      "documentation/**",
      "tools/docs-site/**",
      ".github/workflows/docs.yml",
      ".github/workflows/docs-publish.yml",
    ]);
    expect(workflow.jobs.build.with["site-directory"]).toBe("tools/docs-site");
  });

  test("a docs folder that is the repository itself is the glob **", () => {
    const text = renderScaffold("docs-publish.yml", { ...VALUES, docs: "" });
    const workflow = parse(text) as { on: { push: { paths: string[] } } };
    expect(workflow.on.push.paths[0]).toBe("**");
    // a bare ** would be an alias: this one entry is quoted, the others are plain scalars
    expect(renderScaffold("docs.yml", { ...VALUES, docs: "." })).toContain(
      'paths:\n      - "**"\n      - docs-site/**\n',
    );
  });

  test("refuses values that could not be put into a workflow safely", () => {
    for (const bad of [
      { site: "../docs-site" },
      { site: "docs site" },
      { site: "/abs" },
      { site: "a//b" },
      { site: "a/../b" },
      { site: "docs-site\ninjected: true" },
      { docs: 'docs"] # x' },
      { docs: "a/../../b" },
      { docs: "d*cs" },
      { docs: "/docs" },
      { sha: SHA.slice(0, 39) },
      { sha: SHA.toUpperCase() },
      { sha: "main" },
      { version: "latest" },
    ]) {
      expect(
        () => renderScaffold("docs.yml", { ...VALUES, ...bad }),
        JSON.stringify(bad),
      ).toThrow();
    }
  });

  test("the callers are safe by construction (7 and 9.1 of the record)", () => {
    const docs = renderScaffold("docs.yml", VALUES);
    const publish = renderScaffold("docs-publish.yml", VALUES);
    for (const text of [docs, publish]) {
      const info = inspectCaller(text);
      expect(info.error).toBeNull();
      expect(info.triggers).not.toContain("pull_request_target");
      expect(info.triggers).not.toContain("workflow_run");
      expect(info.writes).toEqual([]);
      expect(Object.values(info.branches).flat()).toEqual([]);
      // every uses: is a 40-hex commit with a version comment
      expect(info.uses.length).toBeGreaterThan(0);
      for (const use of info.uses) {
        expect(use.ref).toMatch(/^[0-9a-f]{40}$/);
        expect(use.version).toBe("0.1.0");
      }
    }
    // the pull request workflow can read and nothing else
    const checks = inspectCaller(docs);
    expect(checks.triggers).toEqual(["pull_request"]);
    expect(checks.jobs.flatMap((job) => job.writes)).toEqual([]);
    expect(checks.uses.map((use) => use.workflow)).toEqual(["docs-build.yml"]);
    // only the publish workflow grants pages and id-token, and only to the deploy job, behind the variable
    const publishing = inspectCaller(publish);
    expect(publishing.triggers).toEqual(["push", "workflow_dispatch"]);
    const deploy = publishing.jobs.find((job) => job.uses?.includes("docs-deploy.yml"));
    expect(deploy?.writes.sort()).toEqual(["id-token", "pages"]);
    expect(deploy?.if).toContain("vars.DOCS_SITE_ENABLED == 'true'");
    expect(publishing.jobs.find((job) => job.id === "build")?.writes).toEqual([]);
  });

  test("the Dependabot snippets are list items of the two ecosystems, with the package excluded from the cooldown", () => {
    const npm = parse(
      `updates:\n${readScaffold("dependabot-npm.yml").replaceAll("@@SITE@@", "docs-site")}`,
    ) as {
      updates: Array<Record<string, unknown>>;
    };
    expect(npm.updates).toHaveLength(1);
    expect(npm.updates[0]).toMatchObject({
      "package-ecosystem": "npm",
      directory: "/docs-site",
      cooldown: { "default-days": 7, exclude: ["@avunu/docusystem"] },
    });
    const actions = parse(`updates:\n${readScaffold("dependabot-actions.yml")}`) as {
      updates: Array<Record<string, unknown>>;
    };
    expect(actions.updates[0]).toMatchObject({
      "package-ecosystem": "github-actions",
      directory: "/",
      cooldown: { exclude: ["Avunu/docusystem"] },
    });
  });

  test("the .gitignore lines", () => {
    expect(readScaffold("gitignore")).toBe("node_modules/\ndist/\n.docusystem/\n");
  });
});

describe("folders", () => {
  test("siteDirProblem accepts what the reusable workflow accepts", () => {
    for (const ok of ["docs-site", "docs_site", "tools/docs-site", "a.b/c-d", "_x"]) {
      expect(siteDirProblem(ok), ok).toBeNull();
    }
    for (const bad of [
      "",
      ".",
      "..",
      "../x",
      "a/..",
      "a//b",
      "a/",
      "/a",
      ".hidden",
      "a b",
      "a..b",
      "a/./b",
      "a\\b",
    ]) {
      expect(siteDirProblem(bad), JSON.stringify(bad)).not.toBeNull();
    }
  });

  test("cleanSiteDir", () => {
    expect(cleanSiteDir("./docs-site/")).toBe("docs-site");
    expect(cleanSiteDir("docs-site//")).toBe("docs-site");
    expect(cleanSiteDir("././a/b")).toBe("a/b");
    expect(cleanSiteDir("")).toBeNull();
    expect(cleanSiteDir("./")).toBeNull();
  });

  test("docsPathProblem and folderGlob", () => {
    expect(docsPathProblem("docs")).toBeNull();
    expect(docsPathProblem("")).toBeNull();
    expect(docsPathProblem("a/b c/d_e.f-g")).toBeNull();
    expect(docsPathProblem("a/../b")).not.toBeNull();
    expect(docsPathProblem("a/*")).not.toBeNull();
    expect(docsPathProblem('a"b')).not.toBeNull();
    expect(folderGlob("docs")).toBe("docs/**");
    expect(folderGlob("")).toBe("**");
  });
});

describe("unifiedDiff", () => {
  test("a new file is all additions", () => {
    expect(unifiedDiff("a.txt", null, "one\ntwo\n")).toEqual([
      "--- /dev/null",
      "+++ b/a.txt",
      "@@ -0,0 +1,2 @@",
      "+one",
      "+two",
    ]);
  });

  test("a change shows its context, and distant changes are separate hunks", () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    const after = before.replace("line 2\n", "line two\n").replace("line 19\n", "line 19\nadded\n");
    const diff = unifiedDiff("f.txt", before, after);
    expect(diff.slice(0, 2)).toEqual(["--- a/f.txt", "+++ b/f.txt"]);
    expect(diff.filter((line) => line.startsWith("@@"))).toEqual([
      "@@ -1,5 +1,5 @@",
      "@@ -17,4 +17,5 @@",
    ]);
    expect(diff).toContain("-line 2");
    expect(diff).toContain("+line two");
    expect(diff).toContain("+added");
  });

  test("nothing differs: no lines", () => {
    expect(unifiedDiff("a", "x\n", "x\n")).toEqual([]);
    expect(unifiedDiff("a", "", "")).toEqual([]);
  });

  test("applying the hunks is not needed to read them: removed and added lines are marked", () => {
    expect(unifiedDiff("a", "a\nb\nc\n", "a\nc\n")).toEqual([
      "--- a/a",
      "+++ b/a",
      "@@ -1,3 +1,2 @@",
      " a",
      "-b",
      " c",
    ]);
  });
});

describe("planChange", () => {
  test("create, update and unchanged", () => {
    expect(planChange("a", null, "x").action).toBe("create");
    expect(planChange("a", "x", "y").action).toBe("update");
    expect(planChange("a", "x", "x", "note")).toEqual({
      path: "a",
      action: "unchanged",
      before: "x",
      after: "x",
      note: "note",
    });
  });
});

describe("inspectCaller", () => {
  test("reads the three spellings of on:", () => {
    expect(inspectCaller("on: push\njobs: {}\n").triggers).toEqual(["push"]);
    expect(inspectCaller("on: [push, pull_request]\njobs: {}\n").triggers).toEqual([
      "push",
      "pull_request",
    ]);
    expect(
      inspectCaller("on:\n  push:\n    branches: [main]\n    paths: ['docs/**']\n").paths,
    ).toEqual({ push: ["docs/**"] });
  });

  test("reports permissions that grant write, at workflow and job level", () => {
    const info = inspectCaller(
      "permissions: write-all\njobs:\n  a:\n    permissions:\n      contents: read\n      pages: write\n    uses: x/y/.github/workflows/z.yml@v1\n",
    );
    expect(info.writes).toEqual(["write-all"]);
    expect(info.jobs[0]?.writes).toEqual(["pages"]);
  });

  test("a version comment is read from the line of the uses", () => {
    const [use] = inspectCaller(
      `jobs:\n  b:\n    uses: Avunu/docusystem/.github/workflows/docs-build.yml@${SHA} # v0.3.1\n`,
    ).uses;
    expect(use).toMatchObject({
      job: "b",
      workflow: "docs-build.yml",
      ref: SHA,
      comment: "v0.3.1",
      version: "0.3.1",
    });
    const [bare] = inspectCaller(
      `jobs:\n  b:\n    uses: Avunu/docusystem/.github/workflows/docs-build.yml@${SHA2}\n`,
    ).uses;
    expect(bare).toMatchObject({ comment: null, version: null });
  });

  test("text that is not YAML is an error value, not an exception", () => {
    expect(inspectCaller("a: [unclosed").error).not.toBeNull();
    expect(inspectCaller("- a\n- b\n").error).toContain("not a workflow");
  });
});

describe("maintainerSteps", () => {
  test("print the values of section 2.5 from the config", () => {
    const steps = maintainerSteps({ domain: "frappe-nix.avunu.net", slug: "frappe-nix" });
    const text = steps.join("\n");
    expect(text).toContain("Source: GitHub Actions");
    expect(text).toContain("Custom domain: frappe-nix.avunu.net");
    expect(text).toContain(
      "CNAME frappe-nix -> avunu.github.io (DNS only until the certificate exists)",
    );
    expect(text).toContain("DOCS_SITE_ENABLED = true");
    expect(text).toContain("Branch protection on the default branch");
    expect(text).toContain("docs: https://frappe-nix.avunu.net in the entry for frappe-nix");
  });

  test("tell a repository with a formatter to run it over the new files, or to ignore docs-site", () => {
    const text = maintainerSteps({ domain: "frappe-nix.avunu.net", slug: "frappe-nix" }).join("\n");
    expect(text).toContain("If a formatter checks every file of the repository (oxfmt, prettier)");
    expect(text).toContain('"ignorePatterns": ["docs-site"]');
  });

  test("a domain outside avunu.net is its own record, and a configured branch is named", () => {
    const text = maintainerSteps({ domain: "docs.example.org", slug: "x", branch: "develop" }).join(
      "\n",
    );
    expect(text).toContain("CNAME docs.example.org -> avunu.github.io");
    expect(text).toContain("Branch protection on develop");
  });
});
