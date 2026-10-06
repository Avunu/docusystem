import { readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { readBundledCatalog } from "../../src/lib/catalog.js";
import { checkSlug, preflight, starterLeftovers } from "../../src/lib/preflight.js";
import { listTree, REPO_ROOT, tempDir, writeTree } from "../support/index.js";
import { GOOD, shell } from "./helpers.js";

describe("checkSlug", () => {
  const slugs = ["erpnext_taskview", "frappe-nix", "cloudflare-email-relay"];

  test("is silent for a catalog key and for an empty catalog", () => {
    expect(checkSlug("frappe-nix", slugs)).toEqual({});
    expect(checkSlug("erpnext_taskview", slugs)).toEqual({});
    expect(checkSlug("anything", [])).toEqual({});
  });

  test("is an error for the other spelling of a key, and says which spelling is the catalog's", () => {
    const result = checkSlug("erpnext-taskview", slugs);
    expect(result.warning).toBeUndefined();
    expect(result.error).toContain(
      'slug "erpnext-taskview" is not in the project catalog, but "erpnext_taskview" is',
    );
    expect(result.error).toContain('Set "slug" to "erpnext_taskview"');
    expect(result.error).toContain("the domain stays as it is");
    // and the other way round
    expect(checkSlug("frappe_nix", slugs).error).toContain('"frappe-nix"');
  });

  test("is a warning for a slug the catalog does not know", () => {
    const result = checkSlug("new-thing", slugs);
    expect(result.error).toBeUndefined();
    expect(result.warning).toContain('slug "new-thing" is not in the project catalog');
    expect(result.warning).toContain("will not mark this project as the current one");
  });

  test("defaults to the bundled catalog: both spellings of erpnext_taskview", () => {
    expect(checkSlug("erpnext_taskview")).toEqual({});
    expect(checkSlug("erpnext-taskview").error).toContain('"erpnext_taskview"');
    expect(checkSlug("a-project-nobody-has-heard-of").warning).toBeDefined();
    for (const { slug } of readBundledCatalog()) expect(checkSlug(slug), slug).toEqual({});
  });
});

describe("preflight: a site that is set up", () => {
  test("passes with no errors and no warnings, and returns the config and the paths", () => {
    const { repo, site } = shell({ config: { ...GOOD, slug: "frappe-nix" } });
    const result = preflight(site);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.config?.slug).toBe("frappe-nix");
    expect(result.paths?.siteDir).toBe(site);
    expect(result.paths?.repoRoot).toBe(repo);
    expect(result.paths?.docsDir).toBe(join(repo, "docs"));
  });

  test("a slug the catalog does not know is only a warning", () => {
    const { site } = shell();
    const result = preflight(site);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('slug "example_project" is not in the project catalog');
  });

  test("writes nothing", () => {
    const { repo, site } = shell();
    const before = listTree(repo);
    preflight(site);
    expect(listTree(repo)).toEqual(before);
  });
});

describe("preflight: the configuration (step 1)", () => {
  test("a missing file", () => {
    const { site } = shell({ config: null });
    const result = preflight(site);
    expect(result.config).toBeUndefined();
    expect(result.paths).toBeUndefined();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("does not exist");
    expect(result.errors[0]).toContain("docusystem init");
  });

  test("every problem at once, and nothing else is checked", () => {
    const { site } = shell({
      config: { ...GOOD, name: "", platform: "windows", tagLine: "x", slug: "erpnext-taskview" },
      home: false,
    });
    const result = preflight(site);
    expect(result.config).toBeUndefined();
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
    for (const error of result.errors)
      expect(error.startsWith("docusystem.config.json: ")).toBe(true);
    expect(result.errors.join("\n")).toContain('did you mean "tagline"?');
    expect(result.warnings).toEqual([]);
  });

  test("a file that is not JSON", () => {
    const { site } = shell({ files: { "docs-site/docusystem.config.json": "{" } });
    expect(preflight(site).errors[0]).toMatch(/^docusystem\.config\.json is not valid JSON/);
  });

  test("docs outside the repository: the config is returned, the paths are not", () => {
    const { site } = shell({ config: { ...GOOD, docs: "../../outside" } });
    const result = preflight(site);
    expect(result.config?.docs).toBe("../../outside");
    expect(result.paths).toBeUndefined();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("outside the repository");
  });

  test("docs that is a link out of the repository", () => {
    const { repo, site } = shell({ config: { ...GOOD, docs: "../linked" } });
    symlinkSync(tempDir(), join(repo, "linked"));
    expect(preflight(site).errors[0]).toContain("outside the repository");
  });
});

describe("preflight: the documentation home (step 2)", () => {
  test.each(["README.md", "readme.md", "Readme.md", "index.md", "INDEX.MD"])(
    "%s is a home page",
    (name) => {
      const { site } = shell({ home: false, files: { [`docs/${name}`]: "# Home\n" } });
      expect(preflight(site).errors).toEqual([]);
    },
  );

  test("a folder without one: the error says what to do, with the cp hint", () => {
    const { site } = shell({ home: false, files: { "docs/guide.md": "# Guide\n" } });
    const { errors } = preflight(site);
    expect(errors).toEqual([
      "docs/README.md is missing: it is the documentation home (/docs/). Add one (index.md works too); for a repository whose README is its documentation: cp README.md docs/README.md",
    ]);
  });

  test("a folder named README.md is not a home page", () => {
    const { site } = shell({ home: false, files: { "docs/index.md/x": "" } });
    expect(preflight(site).errors[0]).toContain("docs/README.md is missing");
  });

  test("no docs folder", () => {
    const { site } = shell({ config: { ...GOOD, docs: "../not-there" } });
    expect(preflight(site).errors).toEqual([
      "The documentation folder not-there/ does not exist. Put your Markdown there; not-there/README.md is the home page.",
    ]);
  });

  test("docs that is a file", () => {
    const { site } = shell({
      config: { ...GOOD, docs: "../README.md" },
      files: { "README.md": "# x\n" },
    });
    expect(preflight(site).errors).toEqual(["The documentation folder README.md is not a folder."]);
  });

  test("a docs folder of another name is named in the messages", () => {
    const { site } = shell({
      config: { ...GOOD, docs: "../documentation" },
      files: { "documentation/guide.md": "# Guide\n" },
    });
    expect(preflight(site).errors).toEqual([
      "documentation/README.md is missing: it is the documentation home (/docs/). Add one (index.md works too); for a repository whose README is its documentation: cp README.md documentation/README.md",
    ]);
  });

  test("the repository root as the docs folder", () => {
    const { site } = shell({ config: { ...GOOD, docs: ".." }, files: { "README.md": "# x\n" } });
    expect(preflight(site).errors).toEqual([]);
    const bare = shell({ config: { ...GOOD, docs: ".." }, home: false });
    expect(preflight(bare.site).errors).toEqual([
      "README.md is missing: it is the documentation home (/docs/). Add one (index.md works too).",
    ]);
  });
});

describe("preflight: the slug against the bundled catalog", () => {
  test("the underscore spelling passes, the hyphen one is an error that names the right one", () => {
    expect(preflight(shell({ config: { ...GOOD, slug: "erpnext_taskview" } }).site)).toMatchObject({
      errors: [],
      warnings: [],
    });
    const wrong = preflight(shell({ config: { ...GOOD, slug: "erpnext-taskview" } }).site);
    expect(wrong.warnings).toEqual([]);
    expect(wrong.errors).toHaveLength(1);
    expect(wrong.errors[0]).toContain('"erpnext_taskview"');
  });

  test("errors of all kinds come together: the docs home and the slug", () => {
    const { site } = shell({
      config: { ...GOOD, slug: "erpnext-taskview" },
      home: false,
      files: { "docs/a.md": "x" },
    });
    expect(preflight(site).errors).toHaveLength(2);
  });
});

describe("preflight: leftovers of the copied starter", () => {
  test.each([
    ["components", "components/ in the site folder is ignored", "overrides/components/"],
    ["layouts", "layouts/ in the site folder is ignored", "overrides/layouts/"],
    ["pages", "pages/ in the site folder is ignored", "overrides/pages/"],
    ["scripts", "scripts/ in the site folder is ignored", "delete this folder"],
    ["data", "data/ in the site folder is ignored", "bundled in the package"],
  ])("%s/ is a warning", (name, start, advice) => {
    const { site } = shell({ files: { [`docs-site/${name}/x.json`]: "{}" } });
    const warnings = preflight(site).warnings.filter((w) => !w.startsWith("slug "));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(start);
    expect(warnings[0]).toContain("leftover of the copied starter");
    expect(warnings[0]).toContain(advice);
  });

  test("project.json is a warning that points at the config", () => {
    const { site } = shell({ files: { "docs-site/project.json": "{}" } });
    const warnings = preflight(site).warnings.filter((w) => !w.startsWith("slug "));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("project.json in the site folder is ignored");
    expect(warnings[0]).toContain('"theme"');
  });

  test("the starter's own configuration file is a warning that says what replaced it", () => {
    const { site } = shell({ files: { "docs-site/docs.config.json": "{}" } });
    const warnings = preflight(site).warnings.filter((w) => !w.startsWith("slug "));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("docs.config.json in the site folder is ignored");
    expect(warnings[0]).toContain("leftover of the copied starter");
    expect(warnings[0]).toContain("docusystem.config.json now");
  });

  test("the starter's README.md is a warning", () => {
    const { site } = shell({ files: { "docs-site/README.md": "# Documentation site\n" } });
    const warnings = preflight(site).warnings.filter((w) => !w.startsWith("slug "));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("README.md in the site folder is ignored");
    expect(warnings[0]).toContain("leftover of the copied starter");
  });

  test("all of them at once, in a fixed order, after the slug warning", () => {
    const files = Object.fromEntries(
      [
        "components/a.json",
        "layouts/b.json",
        "pages/c.json",
        "project.json",
        "scripts/d.ts",
        "data/projects.snapshot.json",
        "docs.config.json",
        "README.md",
      ].map((f) => [`docs-site/${f}`, "x"]),
    );
    const { warnings } = preflight(shell({ files }).site);
    expect(warnings).toHaveLength(9);
    expect(warnings[0]).toContain("slug ");
    expect(warnings.slice(1).map((w) => w.split(" ")[0])).toEqual([
      "components/",
      "layouts/",
      "pages/",
      "project.json",
      "scripts/",
      "data/",
      "docs.config.json",
      "README.md",
    ]);
  });

  test("the overrides and public folders of a real shell are not leftovers", () => {
    const { site } = shell({
      config: { ...GOOD, slug: "frappe-nix" },
      files: {
        "docs-site/overrides/components/docs-footer.json": "{}",
        "docs-site/public/favicon.svg": "<svg/>",
        "docs-site/package.json": "{}",
      },
    });
    expect(preflight(site).warnings).toEqual([]);
  });
});

describe("preflight: the starter's public/ folder", () => {
  const PACKAGE_PUBLIC = join(REPO_ROOT, "site", "public");
  const packageFile = (rel: string): string => readFileSync(join(PACKAGE_PUBLIC, rel), "utf8");
  /** What the starter's public/ was: the package's own files, plus the CNAME init wrote. */
  const starterPublic = {
    "docs-site/public/favicon.svg": packageFile("favicon.svg"),
    "docs-site/public/brand/avunu-icon.svg": packageFile("brand/avunu-icon.svg"),
    "docs-site/public/fonts/LICENSE-Figtree.txt": packageFile("fonts/LICENSE-Figtree.txt"),
    "docs-site/public/CNAME": "example-project.avunu.net\n",
  };
  const publicWarnings = (files: Record<string, string>): string[] =>
    preflight(shell({ files }).site).warnings.filter((w) => w.startsWith("public/"));

  test("files identical to the package's are a leftover, and the warning counts them and names the CNAME", () => {
    const [warning, ...others] = publicWarnings(starterPublic);
    expect(others).toEqual([]);
    expect(warning).toContain(
      "public/ in the site folder holds 3 files identical to the package's own",
    );
    expect(warning).toContain("brand/avunu-icon.svg, favicon.svg, fonts/LICENSE-Figtree.txt");
    expect(warning).toContain("leftover of the copied starter");
    expect(warning).toContain("do not follow package updates");
    expect(warning).toContain("public/CNAME is not allowed either");
  });

  test("one identical file is enough, and without a CNAME the warning does not mention it", () => {
    const [warning] = publicWarnings({
      "docs-site/public/favicon.svg": packageFile("favicon.svg"),
    });
    expect(warning).toContain("holds 1 file identical to the package's own (favicon.svg)");
    expect(warning).not.toContain("CNAME");
  });

  test("a shell's own public/ is not a leftover: new files, and a file of the same name that differs", () => {
    expect(
      publicWarnings({
        "docs-site/public/og.png": "not the package's",
        "docs-site/public/favicon.svg": "<svg>mine</svg>",
        "docs-site/public/brand/logo.svg": "<svg/>",
      }),
    ).toEqual([]);
  });

  test("a CNAME alone is left to the assemble error, not repeated as a leftover", () => {
    expect(publicWarnings({ "docs-site/public/CNAME": "example.avunu.net\n" })).toEqual([]);
  });

  test("a symbolic link is not a copy, and a site without a public/ folder is fine", () => {
    const linked = shell({
      files: { "docs-site/public/favicon.svg": { symlink: join(PACKAGE_PUBLIC, "favicon.svg") } },
    });
    expect(starterLeftovers(linked.site)).toEqual([]);
    expect(starterLeftovers(shell().site)).toEqual([]);
  });

  test("starterLeftovers takes the package's folder as a parameter and returns names in the fixed order", () => {
    const source = tempDir();
    const { site } = shell({
      files: {
        "docs-site/public/a.txt": "same",
        "docs-site/public/b.txt": "different",
        "docs-site/scripts/x.ts": "x",
        "docs-site/docs.config.json": "{}",
      },
    });
    writeTree(source, { "public/a.txt": "same", "public/b.txt": "package's" });
    expect(starterLeftovers(site, { siteSource: source }).map((l) => l.name)).toEqual([
      "scripts",
      "docs.config.json",
      "public",
    ]);
    expect(starterLeftovers(site).map((l) => l.name)).toEqual(["scripts", "docs.config.json"]);
  });
});
