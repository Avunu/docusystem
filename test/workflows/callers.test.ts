// The two caller workflows a consuming repository has (`docs.yml` for pull requests, `docs-publish.yml`
// for the default branch; section 2.2 and 4.4 of the architecture decision record), held to the same
// invariants wherever they come from: the fixtures that stand in for WP6's scaffold and WP9's example
// now, and the real files as soon as those packages have landed (callerSets() picks them up).
import { describe, expect, test } from "vitest";
import {
  CALLER_FILES,
  EXAMPLE_VALUES,
  callerSets,
  parseCaller,
  readText,
  renderTokens,
  usesLines,
  writeScopes,
  type CallerFile,
} from "./helpers.js";

const sets = callerSets();
const BUILD = /^Avunu\/docusystem\/\.github\/workflows\/docs-build\.yml@[0-9a-f]{40}$/;
const DEPLOY = /^Avunu\/docusystem\/\.github\/workflows\/docs-deploy\.yml@[0-9a-f]{40}$/;

describe.each(sets.map((set) => [set.label, set] as const))("callers: %s", (_label, set) => {
  const docs = parseCaller(set.files["docs.yml"]);
  const publish = parseCaller(set.files["docs-publish.yml"]);

  test("neither is triggered by pull_request_target or workflow_run, and neither names a branch", () => {
    for (const file of CALLER_FILES) {
      const doc = parseCaller(set.files[file]);
      const json = JSON.stringify(doc);
      expect(json, file).not.toMatch(/pull_request_target|workflow_run/);
      expect(json, file).not.toMatch(/"branches(?:-ignore)?"/); // the reusable workflows read the default branch
      expect(json, file).not.toMatch(/"secrets":/);
    }
  });

  test("docs.yml runs on pull requests only and grants only contents: read, to its one job", () => {
    expect(Object.keys(docs.on)).toEqual(["pull_request"]);
    expect(docs.permissions).toEqual({});
    expect(Object.keys(docs.jobs)).toEqual(["build"]);
    expect(docs.jobs.build?.permissions).toEqual({ contents: "read" });
    expect(docs.jobs.build?.uses).toMatch(BUILD);
    expect(docs.jobs.build?.with).toEqual({ "site-directory": "docs-site" });
    expect(docs.concurrency?.group).toBe("docs-${{ github.event.pull_request.number }}");
  });

  test("docs-publish.yml runs on a push or by hand, never on a pull request", () => {
    expect(Object.keys(publish.on).sort()).toEqual(["push", "workflow_dispatch"]);
    expect(publish.permissions).toEqual({});
  });

  test("only docs-publish.yml grants pages: write and id-token: write, and only to the deploy job", () => {
    expect(writeScopes(docs.jobs.build?.permissions)).toEqual([]);
    expect(writeScopes(publish.jobs.build?.permissions)).toEqual([]);
    expect(publish.jobs.build?.permissions).toEqual({ contents: "read" });
    expect(publish.jobs.deploy?.permissions).toEqual({ pages: "write", "id-token": "write" });
    expect(set.files["docs.yml"]).not.toMatch(/pages:\s*write|id-token:\s*write/);
  });

  test("the deploy job waits for the build and for DOCS_SITE_ENABLED, which also decides the Pages artifact", () => {
    expect(Object.keys(publish.jobs)).toEqual(["build", "deploy"]);
    expect(publish.jobs.build?.uses).toMatch(BUILD);
    expect(publish.jobs.build?.with).toEqual({
      "site-directory": "docs-site",
      "pages-artifact": "${{ vars.DOCS_SITE_ENABLED == 'true' }}",
    });
    expect(publish.jobs.deploy?.needs).toBe("build");
    expect(publish.jobs.deploy?.if).toBe("${{ vars.DOCS_SITE_ENABLED == 'true' }}");
    expect(publish.jobs.deploy?.uses).toMatch(DEPLOY);
    expect(publish.jobs.deploy?.with).toBeUndefined(); // the deploy workflow takes no inputs
  });

  test("every uses is a full commit with a version comment, and all of them are the same commit", () => {
    const shas = new Set<string>();
    const versions = new Set<string>();
    for (const file of CALLER_FILES) {
      const lines = usesLines(set.files[file]);
      expect(lines.length, file).toBeGreaterThan(0);
      for (const { ref, comment, line } of lines) {
        expect(ref, `${file}:${line}`).toMatch(
          /^Avunu\/docusystem\/\.github\/workflows\/docs-(?:build|deploy)\.yml@[0-9a-f]{40}$/,
        );
        expect(comment, `${file}:${line}`).toMatch(/^v\d+\.\d+\.\d+$/);
        shas.add(ref.split("@")[1] ?? "");
        versions.add(comment ?? "");
      }
    }
    expect(shas.size).toBe(1);
    expect(versions.size).toBe(1);
  });

  test("both watch the documentation folder, the site folder and the two callers, and agree on them", () => {
    const paths = (file: CallerFile): unknown => {
      const doc = parseCaller(set.files[file]);
      const event = file === "docs.yml" ? doc.on.pull_request : doc.on.push;
      return (event as { paths: string[] }).paths;
    };
    const expected = [
      "docs/**",
      "docs-site/**",
      ".github/workflows/docs.yml",
      ".github/workflows/docs-publish.yml",
    ];
    expect(paths("docs.yml")).toEqual(expected);
    expect(paths("docs-publish.yml")).toEqual(expected);
  });
});

describe("the callers agree with each other where more than one source exists", () => {
  const byLabel = (needle: string) => sets.find((set) => set.label.startsWith(needle));
  const fixtureExample = byLabel("fixture: the example shell");
  const fixtureScaffold = byLabel("fixture: the scaffold");
  const realScaffold = byLabel("scaffold/");
  const realExample = byLabel("examples/basic");

  test("the fixture scaffold, rendered with the example's values, is the fixture example, byte for byte", () => {
    expect(fixtureScaffold?.files).toEqual(fixtureExample?.files);
  });

  // Skipped, and reported as skipped, until WP6 (scaffold/) and WP9 (examples/basic) have landed.
  test.skipIf(realScaffold === undefined || realExample === undefined)(
    "scaffold/ (WP6), rendered with the example's values, is what the example holds (WP9), byte for byte",
    () => {
      expect(realScaffold?.files).toEqual(realExample?.files);
    },
  );

  test("whichever of scaffold/ and examples/basic exists equals the fixture example", () => {
    for (const label of ["scaffold/", "examples/basic"]) {
      const set = byLabel(label);
      if (set !== undefined) expect(set.files, label).toEqual(fixtureExample?.files);
    }
  });

  test("the tokens of a scaffold template are exactly the four of init, and rendering leaves none behind", () => {
    for (const file of CALLER_FILES) {
      const template = readText("test", "workflows", "fixtures", "scaffold", file);
      expect([...new Set(template.match(/@@[A-Z]+@@/g))].sort()).toEqual([
        "@@DOCS@@",
        "@@SHA@@",
        "@@SITE@@",
        "@@VERSION@@",
      ]);
      expect(renderTokens(template, EXAMPLE_VALUES)).not.toMatch(/@@/);
    }
  });

  test("a repository whose folders differ renders paths and site-directory from its own values", () => {
    const template = readText("test", "workflows", "fixtures", "scaffold", "docs.yml");
    const doc = parseCaller(
      renderTokens(template, {
        docs: "documentation",
        site: "site/docs",
        sha: "a".repeat(40),
        version: "v1.2.3",
      }),
    );
    expect(doc.jobs.build?.with).toEqual({ "site-directory": "site/docs" });
    expect((doc.on.pull_request as { paths: string[] }).paths.slice(0, 2)).toEqual([
      "documentation/**",
      "site/docs/**",
    ]);
    expect(doc.jobs.build?.uses).toBe(
      `Avunu/docusystem/.github/workflows/docs-build.yml@${"a".repeat(40)}`,
    );
  });
});
