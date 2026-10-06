// Documented fakes for the modules that other work packages own and that were still stubs when WP6
// was written (WP1: config, catalog, preflight; WP2: overrides). Each `fake*` function takes the
// module as it is in the tree and returns it unchanged when it is implemented; only a module whose
// functions still throw "not implemented (WPn)" is replaced by a stand-in that follows the
// behaviour frozen in the architecture decision record (4.1, 4.2, Appendix B). So the same tests that
// run against the fakes today become the integration tests of WP6 with WP1 and WP2 the moment those
// merge, without an edit.
//
// Use in a test file (the factory must import this file dynamically, because vi.mock is hoisted):
//
//   vi.mock("../../src/lib/config.js", (original) =>
//     import("./support/neighbours.js").then((m) => m.mockConfig(original)));
//
// This file must not import a module that a test mocks (src/lib/*): the factory waits for this file.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { vi } from "vitest";
import type { CatalogProject, DocsConfig, Finding, Paths } from "../../../src/lib/types.js";
import { REPO_ROOT } from "../../support/paths.js";
import { initFixture } from "./fixtures.js";

type ConfigModule = typeof import("../../../src/lib/config.js");
type CatalogModule = typeof import("../../../src/lib/catalog.js");
type PreflightModule = typeof import("../../../src/lib/preflight.js");
type OverridesModule = typeof import("../../../src/lib/overrides.js");

/** Whether calling `probe` fails with the marker of an unimplemented stub. */
export function isStub(probe: () => unknown): boolean {
  try {
    probe();
    return false;
  } catch (error) {
    return /^not implemented \(WP\d+\)/.test((error as Error).message);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// ---- the catalog (WP1) ----

/** The catalog the fakes serve: a subset of the bundled snapshot, in `test/init/fixtures/catalog.json`. */
export function fixtureCatalog(): CatalogProject[] {
  const doc = JSON.parse(readFileSync(initFixture("catalog.json"), "utf8")) as {
    projects: CatalogProject[];
  };
  return doc.projects;
}

const sameRepo = (a: string, b: string): boolean =>
  a.replace(/\.git$/, "").toLowerCase() === b.replace(/\.git$/, "").toLowerCase();

export function fakeCatalog(real: CatalogModule): CatalogModule {
  if (!isStub(() => real.readBundledCatalog())) return real;
  return {
    ...real,
    readBundledCatalog: fixtureCatalog,
    entryFor(projects, repo) {
      const matches = projects.filter((project) => sameRepo(project.repo, repo));
      if (matches.length === 1) return { entry: matches[0], ambiguous: [] };
      return { ambiguous: matches.length > 1 ? matches : [] };
    },
  };
}

export function fakePreflight(real: PreflightModule): PreflightModule {
  if (!isStub(() => real.checkSlug("x", []))) return real;
  return {
    ...real,
    checkSlug(slug, slugs = fixtureCatalog().map((project) => project.slug)) {
      if (slugs.includes(slug)) return {};
      const squash = (text: string): string => text.replace(/[-_]/g, "");
      const near = slugs.find((candidate) => squash(candidate) === squash(slug));
      if (near !== undefined) {
        return { error: `slug "${slug}" is spelled differently from the catalog's key "${near}"` };
      }
      return { warning: `slug "${slug}" is not in the bundled catalog` };
    },
  };
}

// ---- config (WP1) ----

const REQUIRED = ["name", "tagline", "slug", "platform", "repo", "domain", "license"];
const OPTIONAL = ["$schema", "branch", "docs", "theme", "images", "jx"];

/** The schema of 4.2 as a function: every problem as a sentence. */
function validateConfig(raw: unknown): string[] {
  if (!isRecord(raw)) return ["the configuration must be a JSON object"];
  const problems: string[] = [];
  for (const key of REQUIRED) if (!(key in raw)) problems.push(`"${key}" is required`);
  for (const key of Object.keys(raw)) {
    if (![...REQUIRED, ...OPTIONAL].includes(key)) {
      problems.push(`"${key}" is not a docusystem setting`);
    }
  }
  const text = (key: string, max: number): void => {
    const value = raw[key];
    if (key in raw && (typeof value !== "string" || value === "" || value.length > max)) {
      problems.push(`"${key}" must be a text of 1 to ${max} characters`);
    }
  };
  text("name", 80);
  text("tagline", 200);
  text("license", 80);
  const pattern = (key: string, rule: RegExp, hint: string): void => {
    const value = raw[key];
    if (key in raw && (typeof value !== "string" || !rule.test(value))) {
      problems.push(`"${key}" ${hint}`);
    }
  };
  pattern("slug", /^[a-z0-9][a-z0-9_-]*$/, "must be lower case letters, digits, - and _");
  pattern(
    "repo",
    /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/,
    "must be https://github.com/<owner>/<name>",
  );
  pattern(
    "domain",
    /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/,
    "must be a domain name such as docs.example.org",
  );
  pattern("branch", /^(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9_][\w./-]{0,99}$/, "must be a branch name");
  if (
    "platform" in raw &&
    !["frappe", "odoo", "wordpress", "nixos", "general"].includes(String(raw.platform))
  ) {
    problems.push('"platform" must be one of frappe, odoo, wordpress, nixos, general');
  }
  if ("images" in raw && !["optimize", "off"].includes(String(raw.images))) {
    problems.push('"images" must be "optimize" or "off"');
  }
  if ("docs" in raw && (typeof raw.docs !== "string" || raw.docs === "")) {
    problems.push('"docs" must be a folder');
  }
  return problems;
}

export function fakeConfig(real: ConfigModule): ConfigModule {
  if (!isStub(() => real.validateConfig(null))) return real;
  const findRepoRoot = (siteDir: string): string => {
    let dir = resolve(siteDir);
    for (;;) {
      if (existsSync(join(dir, ".git"))) return dir;
      const parent = dirname(dir);
      if (parent === dir) return dirname(resolve(siteDir));
      dir = parent;
    }
  };
  return {
    ...real,
    validateConfig,
    readConfig(siteDir) {
      const file = join(siteDir, real.CONFIG_FILE);
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(file, "utf8"));
      } catch (error) {
        throw new real.ConfigError([`cannot read ${file}: ${(error as Error).message}`]);
      }
      const problems = validateConfig(raw);
      if (problems.length > 0) throw new real.ConfigError(problems);
      return raw as DocsConfig;
    },
    findSiteDir(arg, cwd) {
      const has = (dir: string): boolean => existsSync(join(dir, real.CONFIG_FILE));
      if (arg !== undefined) {
        const dir = resolve(cwd, arg);
        if (has(dir)) return dir;
        throw new Error(`no ${real.CONFIG_FILE} in ${dir}`);
      }
      if (has(cwd)) return cwd;
      if (has(join(cwd, "docs-site"))) return join(cwd, "docs-site");
      throw new Error(
        `no ${real.CONFIG_FILE} found: looked in ${cwd} and ${join(cwd, "docs-site")}`,
      );
    },
    findRepoRoot,
    pathsFor(siteDir, config): Paths {
      const repoRoot = findRepoRoot(siteDir);
      const docsDir = resolve(siteDir, config.docs ?? "../docs");
      if (relative(repoRoot, docsDir).startsWith("..")) {
        throw new Error(`the docs folder ${docsDir} is outside the repository`);
      }
      const work = join(siteDir, ".docusystem");
      const root = join(work, "site");
      return {
        siteDir,
        repoRoot,
        docsDir,
        work,
        root,
        stagedDocs: join(root, ".generated", "docs"),
        navFile: join(root, ".generated", "nav.json"),
        jxDist: join(root, "dist"),
        dist: join(siteDir, "dist"),
        serve: join(work, "serve"),
        manifest: join(work, "manifest.json"),
        jxLog: join(work, "jx.log"),
        lock: join(work, "lock"),
      };
    },
  };
}

// ---- overrides (WP2) ----

/** The package's `site/` folder (WP7's files): the fake `eject` copies from it. */
export function packageSiteForTests(): string {
  return join(REPO_ROOT, "site");
}

/** The version the fake `eject` records: the tests fix the package version to this one. */
const FAKE_VERSION = "0.1.0";

const sha = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");

export function fakeOverrides(real: OverridesModule): OverridesModule {
  if (!isStub(() => real.overrideFindings("/nonexistent"))) return real;
  type Record = { from: string; sha256: string };
  const recordFile = (siteDir: string): string => join(siteDir, "overrides", ".ejected.json");
  const readRecord = (siteDir: string): { [file: string]: Record } =>
    existsSync(recordFile(siteDir))
      ? (JSON.parse(readFileSync(recordFile(siteDir), "utf8")) as { [file: string]: Record })
      : {};
  return {
    ...real,
    ejectFile(siteDir, rel, o) {
      const from = join(packageSiteForTests(), ...rel.split("/"));
      if (!existsSync(from)) throw new Error(`the package has no file ${rel}`);
      const to = join(siteDir, "overrides", ...rel.split("/"));
      if (existsSync(to) && o?.force !== true) throw new Error(`overrides/${rel} exists already`);
      mkdirSync(dirname(to), { recursive: true });
      writeFileSync(to, readFileSync(from));
      const known = readRecord(siteDir);
      known[rel] = { from: FAKE_VERSION, sha256: sha(from) };
      writeFileSync(recordFile(siteDir), `${JSON.stringify(known, null, 2)}\n`);
      return { to };
    },
    overrideFindings(siteDir): Finding[] {
      const known = readRecord(siteDir);
      const findings: Finding[] = [];
      for (const dir of ["components", "layouts", "pages"]) {
        const base = join(siteDir, "overrides", dir);
        if (!existsSync(base)) continue;
        for (const file of readdirSync(base)) {
          const rel = `${dir}/${file}`;
          const shipped = join(packageSiteForTests(), ...rel.split("/"));
          const note = known[rel];
          if (!existsSync(shipped)) {
            if (note !== undefined) {
              findings.push({
                level: "error",
                message: `overrides/${rel} was ejected from a file the package no longer ships`,
              });
            }
          } else if (note === undefined) {
            findings.push({
              level: "warning",
              message: `overrides/${rel} replaces a package file but was not made with eject`,
            });
          } else if (note.sha256 !== sha(shipped)) {
            findings.push({
              level: "warning",
              message: `overrides/${rel} was copied from ${note.from}: the package's file changed`,
            });
          } else {
            findings.push({ level: "ok", message: `overrides/${rel} is current` });
          }
        }
      }
      return findings;
    },
  };
}

/** `a/b/c` as the platform's path (for expectations that compare with `path.join` results). */
export const native = (path: string): string => path.split("/").join(sep);

// ---- the factories for vi.mock ----
//
// vi.mock("../../src/lib/catalog.js", (original) => import("./support/neighbours.js").then((m) => m.mockCatalog(original)));

type Original = <T>() => Promise<T>;

/** The config module, faked while it is a stub. */
export async function mockConfig(original: Original): Promise<ConfigModule> {
  return fakeConfig(await original<ConfigModule>());
}

/** The catalog module, faked while it is a stub; the two functions are spies so that a test can change what they return. */
export async function mockCatalog(original: Original): Promise<CatalogModule> {
  const module = fakeCatalog(await original<CatalogModule>());
  return {
    ...module,
    readBundledCatalog: vi.fn(module.readBundledCatalog),
    entryFor: vi.fn(module.entryFor),
  };
}

export async function mockPreflight(original: Original): Promise<PreflightModule> {
  return fakePreflight(await original<PreflightModule>());
}

/** The overrides module, faked while it is a stub; the functions are spies. */
export async function mockOverrides(original: Original): Promise<OverridesModule> {
  const module = fakeOverrides(await original<OverridesModule>());
  return {
    ...module,
    ejectFile: vi.fn(module.ejectFile),
    overrideFindings: vi.fn(module.overrideFindings),
  };
}

type PackageInfoModule = typeof import("../../../src/lib/package-info.js");

/**
 * The package facts with a fixed version, so that no test depends on the number release-please will
 * write into package.json (0.0.0 today). The folder stays the real one.
 */
export async function mockPackageInfo(original: Original): Promise<PackageInfoModule> {
  return { ...(await original<PackageInfoModule>()), version: "0.1.0", major: 0 };
}
