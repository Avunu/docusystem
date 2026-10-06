import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  CATALOG_URL,
  bundledCatalogFile,
  catalogChanges,
  entryFor,
  readBundledCatalog,
  readBundledCatalogDocument,
  repoName,
  sameRepo,
  validateCatalog,
} from "../../src/lib/catalog.js";
import { packageRoot } from "../../src/lib/package-info.js";
import { PLATFORMS } from "../../src/lib/platforms.js";
import type { CatalogProject } from "../../src/lib/types.js";
import { tempDir } from "../support/index.js";
import { catalog, entry } from "./helpers.js";

const project = (over: Record<string, unknown> = {}): CatalogProject =>
  entry(over) as CatalogProject;

describe("the bundled catalog", () => {
  test("is at site/data/projects.snapshot.json of the package", () => {
    expect(bundledCatalogFile()).toBe(join(packageRoot, "site", "data", "projects.snapshot.json"));
  });

  test("conforms to the version 1 contract", () => {
    const document = JSON.parse(readFileSync(bundledCatalogFile(), "utf8"));
    expect(validateCatalog(document)).toEqual([]);
    expect(document.projects.length).toBeGreaterThan(0);
  });

  test("readBundledCatalog returns its projects, readBundledCatalogDocument the whole document", () => {
    const document = JSON.parse(readFileSync(bundledCatalogFile(), "utf8"));
    expect(readBundledCatalog()).toEqual(document.projects);
    expect(readBundledCatalogDocument()).toEqual(document);
  });

  test("every entry is on a platform the config knows, and slugs are unique", () => {
    const projects = readBundledCatalog();
    const slugs = projects.map((p) => p.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const p of projects) expect(PLATFORMS).toContain(p.platform);
  });

  test("holds the slugs the pilots and docs sites use, spelled as the catalog spells them", () => {
    const slugs = readBundledCatalog().map((p) => p.slug);
    expect(slugs).toContain("erpnext_taskview");
    expect(slugs).not.toContain("erpnext-taskview");
    expect(slugs).toContain("frappe-nix");
    expect(slugs).toContain("cloudflare-email-relay");
  });

  test("is pretty-printed JSON with a trailing newline, as syncCatalog writes it", () => {
    const text = readFileSync(bundledCatalogFile(), "utf8");
    expect(text).toBe(`${JSON.stringify(JSON.parse(text), null, 2)}\n`);
  });

  test("a broken copy is reported as a broken installation, not as an empty catalog", () => {
    // The default file is the package's own; the broken ones are made here.
    const dir = tempDir();
    const missing = join(dir, "missing.json");
    expect(() => readBundledCatalogDocument(missing)).toThrow(
      /cannot be read.*reinstall @avunu\/docusystem/,
    );
    const notJson = join(dir, "not-json.json");
    writeFileSync(notJson, "<html>");
    expect(() => readBundledCatalogDocument(notJson)).toThrow(/cannot be read/);
    const wrong = join(dir, "wrong.json");
    writeFileSync(wrong, JSON.stringify({ ...catalog(), version: 2 }));
    expect(() => readBundledCatalogDocument(wrong)).toThrow(
      /does not conform to the contract \("version" must be 1/,
    );
  });

  test("the live address is avunu.net's projects.json", () => {
    expect(CATALOG_URL).toBe("https://avunu.net/projects.json");
  });
});

describe("validateCatalog", () => {
  test("accepts a catalog, with an entry that has its own docs, a suite and no license", () => {
    expect(validateCatalog(catalog())).toEqual([]);
    expect(
      validateCatalog(
        catalog([
          project({ docs: "https://frappe-nix.avunu.net", suite: "nix-platform", license: null }),
        ]),
      ),
    ).toEqual([]);
  });

  test("accepts extra fields (a later minor may add some)", () => {
    expect(validateCatalog({ ...catalog([{ ...project(), extra: 1 }]), note: "x" })).toEqual([]);
  });

  test("the document itself", () => {
    expect(validateCatalog("nope")).toEqual(["the document is not a JSON object"]);
    expect(validateCatalog(null)).toEqual(["the document is not a JSON object"]);
    expect(validateCatalog([])).toEqual(["the document is not a JSON object"]);
    expect(validateCatalog({ ...catalog(), version: 2 })[0]).toBe('"version" must be 1 (got 2)');
    expect(validateCatalog({ ...catalog(), version: "1" })[0]).toContain('"version" must be 1');
    expect(validateCatalog({ ...catalog(), generated: "" })).toEqual([
      '"generated" must be a timestamp string',
    ]);
    expect(validateCatalog({ ...catalog(), generated: 5 })).toEqual([
      '"generated" must be a timestamp string',
    ]);
    expect(validateCatalog({ ...catalog(), site: "http://avunu.net" })).toEqual([
      '"site" must be an https URL',
    ]);
    expect(validateCatalog({ ...catalog(), projects: [] })).toEqual(['"projects" is empty']);
    expect(validateCatalog({ version: 1, generated: "x", site: "https://avunu.net" })).toContain(
      '"projects" must be an array',
    );
  });

  test("every entry is checked field by field", () => {
    const one = (over: Record<string, unknown>): string[] =>
      validateCatalog(catalog([project(over)]));
    expect(one({ platform: "erpnext" })).toEqual([
      'frappe-nix: "platform" must be one of frappe, odoo, wordpress, nixos, general',
    ]);
    expect(one({ platform: undefined })[0]).toContain('"platform"');
    expect(one({ docs: "http://x.avunu.net" })).toEqual([
      'frappe-nix: "docs" must be an https URL or null',
    ]);
    expect(one({ docs: undefined })).toEqual(['frappe-nix: "docs" must be an https URL or null']);
    expect(one({ page: "javascript:alert(1)" })).toEqual([
      'frappe-nix: "page" must be an https URL',
    ]);
    expect(one({ repo: "https://" })).toEqual(['frappe-nix: "repo" must be an https URL']);
    expect(one({ repo: "https://github.com/a b" })).toEqual([
      'frappe-nix: "repo" must be an https URL',
    ]);
    expect(one({ repo: "github.com/Avunu/x" })).toEqual([
      'frappe-nix: "repo" must be an https URL',
    ]);
    expect(one({ slug: "" })[0]).toContain('"slug" must be a non-empty string');
    expect(one({ title: 5 })).toEqual(['frappe-nix: "title" must be a non-empty string']);
    expect(one({ summary: "" })).toEqual(['frappe-nix: "summary" must be a non-empty string']);
    expect(one({ license: 5 })).toEqual(['frappe-nix: "license" must be a string or null']);
    expect(one({ license: undefined })).toEqual(['frappe-nix: "license" must be a string or null']);
    expect(one({ status: null })).toEqual(['frappe-nix: "status" must be a string']);
    expect(one({ suite: 3 })).toEqual(['frappe-nix: "suite" must be a string or null']);
  });

  test("an entry that is not an object, and a duplicate slug", () => {
    expect(validateCatalog(catalog([null]))).toEqual(["projects[0] is not an object"]);
    expect(validateCatalog(catalog([project(), "x"]))).toEqual(["projects[1] is not an object"]);
    expect(validateCatalog(catalog([project(), project()]))).toEqual([
      "frappe-nix: duplicate slug",
    ]);
  });

  test("all problems of a bad document come at once", () => {
    const problems = validateCatalog({
      version: 3,
      generated: 1,
      site: "x",
      projects: [project({ platform: "x", repo: "x", docs: 1 })],
    });
    expect(problems).toHaveLength(6);
  });
});

describe("sameRepo and repoName", () => {
  test("case, .git, a trailing slash and the short form do not matter", () => {
    const repo = "https://github.com/Avunu/avunu-odoo-addons";
    expect(sameRepo(repo, "https://github.com/avunu/Avunu-Odoo-Addons.git")).toBe(true);
    expect(sameRepo(repo, "https://github.com/Avunu/avunu-odoo-addons/")).toBe(true);
    expect(sameRepo(repo, "Avunu/avunu-odoo-addons")).toBe(true);
    expect(sameRepo(repo, "http://www.github.com/Avunu/avunu-odoo-addons.git/")).toBe(true);
    expect(sameRepo(repo, "https://github.com/Avunu/odoo-nix")).toBe(false);
    expect(sameRepo(repo, "https://github.com/Other/avunu-odoo-addons")).toBe(false);
  });

  test("the name is the last part", () => {
    expect(repoName("https://github.com/Avunu/erpnext_taskview")).toBe("erpnext_taskview");
    expect(repoName("https://github.com/Avunu/Frappe-Nix.git")).toBe("frappe-nix");
    expect(repoName("Avunu/x/")).toBe("x");
  });
});

describe("entryFor", () => {
  const suite = (slug: string): CatalogProject =>
    project({ slug, repo: "https://github.com/Avunu/suite" });

  test("the one entry of a repository", () => {
    const projects = readBundledCatalog();
    const result = entryFor(projects, "https://github.com/Avunu/frappe-nix");
    expect(result.entry?.slug).toBe("frappe-nix");
    expect(result.ambiguous).toEqual([]);
  });

  test("a repository with no entry", () => {
    expect(entryFor(readBundledCatalog(), "https://github.com/Avunu/not-in-the-catalog")).toEqual({
      ambiguous: [],
    });
    expect(entryFor([], "https://github.com/Avunu/x")).toEqual({ ambiguous: [] });
  });

  test("the address may be written in any of the ways of sameRepo", () => {
    for (const repo of [
      "Avunu/frappe-nix",
      "https://github.com/avunu/FRAPPE-NIX.git",
      "https://github.com/Avunu/frappe-nix/",
    ]) {
      expect(entryFor(readBundledCatalog(), repo).entry?.slug, repo).toBe("frappe-nix");
    }
  });

  test("several entries and none named like the repository: ambiguous, with the entries listed", () => {
    const result = entryFor([suite("a"), suite("b"), project()], "https://github.com/Avunu/suite");
    expect(result.entry).toBeUndefined();
    expect(result.ambiguous.map((p) => p.slug)).toEqual(["a", "b"]);
  });

  test("several entries, one named like the repository: that one", () => {
    const result = entryFor(
      [suite("a"), suite("suite"), suite("b")],
      "https://github.com/Avunu/suite",
    );
    expect(result.entry?.slug).toBe("suite");
    expect(result.ambiguous).toEqual([]);
    expect(entryFor([suite("a"), suite("SUITE")], "Avunu/Suite").entry?.slug).toBe("SUITE");
  });

  test("hyphens and underscores are the same letter for being named like the repository", () => {
    const repo = "https://github.com/Avunu/my_suite";
    const one = (slug: string): CatalogProject => project({ slug, repo });
    expect(entryFor([one("a"), one("my-suite")], repo).entry?.slug).toBe("my-suite");
    // two of them: not decided for the caller
    expect(entryFor([one("my-suite"), one("my_suite")], repo).entry?.slug).toBe("my_suite");
    expect(entryFor([one("a"), one("my-suite"), one("My-suite")], repo).entry).toBeUndefined();
  });

  test("avunu-odoo-addons has five entries: ambiguous until one is named like the repository", () => {
    const repo = "https://github.com/Avunu/avunu-odoo-addons";
    const projects = readBundledCatalog();
    const entries = projects.filter((p) => sameRepo(p.repo, repo));
    expect(entries.length).toBeGreaterThan(1);

    // The bundled catalog has an entry named like the repository, which decides it ...
    expect(entryFor(projects, repo).entry?.slug).toBe("avunu-odoo-addons");
    // ... and without it the repository is ambiguous: init asks for --slug and lists the others.
    const without = projects.filter((p) => p.slug !== "avunu-odoo-addons");
    const result = entryFor(without, repo);
    expect(result.entry).toBeUndefined();
    expect(result.ambiguous.map((p) => p.slug)).toEqual(
      entries.map((p) => p.slug).filter((s) => s !== "avunu-odoo-addons"),
    );
    expect(result.ambiguous.length).toBeGreaterThan(1);
    expect(entryFor(without, "Avunu/avunu-odoo-addons").ambiguous).toHaveLength(
      result.ambiguous.length,
    );
  });

  test("the two spellings of erpnext_taskview: the repository's entry is the underscore one", () => {
    expect(
      entryFor(readBundledCatalog(), "https://github.com/Avunu/erpnext_taskview").entry?.slug,
    ).toBe("erpnext_taskview");
  });
});

describe("catalogChanges", () => {
  test("nothing, when only the generated stamp differs", () => {
    expect(catalogChanges(catalog(), { ...catalog(), generated: "2027-01-01T00:00:00Z" })).toEqual(
      [],
    );
  });

  test("an added, a removed and a changed project", () => {
    const before = catalog([
      project(),
      project({ slug: "old", repo: "https://github.com/Avunu/old" }),
    ]);
    const after = catalog([
      project({ docs: "https://frappe-nix.avunu.net", status: "stable" }),
      project({ slug: "new", platform: "odoo", repo: "https://github.com/Avunu/new" }),
    ]);
    expect(catalogChanges(before, after)).toEqual([
      "changed frappe-nix: docs, status",
      "added new (odoo)",
      "removed old",
    ]);
  });

  test("a changed site, and a field that is gone", () => {
    const changed = { ...catalog(), site: "https://example.org" };
    expect(catalogChanges(catalog(), changed)).toEqual([
      "changed the site: https://avunu.net to https://example.org",
    ]);
    const { suite: _suite, ...withoutSuite } = project();
    expect(catalogChanges(catalog(), catalog([withoutSuite]))).toEqual([
      "changed frappe-nix: suite",
    ]);
  });

  test("the order of the projects does not matter", () => {
    const a = project();
    const b = project({ slug: "b", repo: "https://github.com/Avunu/b" });
    expect(catalogChanges(catalog([a, b]), catalog([b, a]))).toEqual([]);
  });
});
