// Helpers for the tests of the migration scripts (scripts/migrate-pilot.mjs, scripts/rehearse-pilots.mjs,
// scripts/legacy/*): the scripts themselves (plain JavaScript, so typed here), the package helpers the
// migration needs as they are in `src/` (the script loads them from `dist/` when it runs for real, which a
// test cannot assume), and a synthetic clone of a repository that carries a copy of the starter.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import * as automerge from "../../src/lib/automerge.js";
import * as config from "../../src/lib/config.js";
import * as dependabot from "../../src/lib/dependabot.js";
import * as pin from "../../src/lib/pin.js";
import * as workflows from "../../src/lib/workflows.js";
import { REPO_ROOT, tempDir, writeTree, type TreeSpec } from "../support/index.js";

// ---- the scripts, typed ----

export interface Action {
  kind: "delete" | "create" | "update";
  path: string;
  why: string;
  before?: string | null;
  after?: string;
  dir?: boolean;
}

export interface Plan {
  clone: string;
  site: string;
  version: string;
  range: string;
  sha: string;
  shaGiven: boolean;
  actions: Action[];
  kept: Array<{ path: string; why: string }>;
  mentions: Array<{ file: string; lines: Array<{ line: number; text: string }> }>;
  advice: string[];
  errors: string[];
}

export interface Legacy {
  files: Record<string, string>;
  canonical: Record<string, { ignore: string[]; sha256: string }>;
  source?: Record<string, string>;
}

export type Helpers = Record<string, unknown>;

export interface PlanOptions {
  helpers: Helpers;
  legacy: Legacy;
  siteDir?: string;
  version?: string;
  range?: string;
  sha?: string;
}

export interface MigrateScript {
  planMigration(clone: string, o: PlanOptions): Plan;
  applyPlan(plan: Plan, helpers: Helpers): void;
  formatPlan(
    plan: Plan,
    o?: { write?: boolean; diff?: boolean; unifiedDiff?: (...args: never[]) => string[] },
  ): string[];
  summarize(plan: Plan): { delete: number; update: number; create: number; kept: number };
  parseOptions(argv: string[]): Record<string, unknown> & { error?: string; help?: boolean };
  loadHelpers(root?: string): Promise<Helpers>;
  loadLegacy(file?: string): Legacy;
  pickHelpers(...modules: object[]): Helpers;
  rangeFor(version: string): string;
  HELPERS: string[];
  LEGACY_FILE: string;
  PLACEHOLDER_SHA: string;
}

export interface Canonical {
  canonicalize(value: unknown): unknown;
  canonicalSha256(value: unknown, ignore?: string[]): string;
}

export interface Generator {
  describeStarter(
    dir: string,
    commit: string,
  ): Legacy & { note: string; source: Record<string, string> };
  listFiles(dir: string): string[];
  CANONICAL: Record<string, string[]>;
}

export interface Rehearse {
  PILOTS: Array<{ name: string; url: string }>;
  ALLOWED_DIFFERENCES: string[];
  EXPECTED_MODIFIED: string[];
  EXPECTED_CREATED: string[];
  expectedStatus(o: { tracked: string[]; kept?: string[] }): Status;
  parseStatus(porcelain: string): Status & { other: string[] };
  statusDifferences(expected: Status, actual: Status & { other?: string[] }): string[];
  readCheckOutput(output: string): {
    pages: number | null;
    references: number | null;
    routes: number | null;
    contrastPairs: number | null;
    contrastFailures: number | null;
    passed: boolean;
  };
  searchDocuments(dist: string): number | null;
  parseOptions(argv: string[]): Record<string, unknown> & { error?: string; help?: boolean };
  renderSummary(results: Array<Record<string, unknown>>): string[];
}

export interface Status {
  deleted: string[];
  modified: string[];
  created: string[];
}

const load = async <T>(...parts: string[]): Promise<T> =>
  (await import(pathToFileURL(join(REPO_ROOT, ...parts)).href)) as T;

export const migrate = (): Promise<MigrateScript> => load("scripts", "migrate-pilot.mjs");
export const canonical = (): Promise<Canonical> => load("scripts", "legacy", "canonical.mjs");
export const generator = (): Promise<Generator> =>
  load("scripts", "legacy", "generate-starter-v0.mjs");
export const rehearsal = (): Promise<Rehearse> => load("scripts", "rehearse-pilots.mjs");

/** The helpers of the package, from `src/` (what `loadHelpers` takes from `dist/`). */
export async function srcHelpers(): Promise<Helpers> {
  return (await migrate()).pickHelpers(workflows, dependabot, automerge, pin, config);
}

export const sha256 = (data: string | Uint8Array): string =>
  createHash("sha256").update(data).digest("hex");

// ---- a synthetic starter and a clone that carries a copy of it ----

export const SHA = "0123456789abcdef0123456789abcdef01234567";

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** What the synthetic starter's template holds: small files standing for the 83 of the real one. */
export const STARTER: Record<string, string> = {
  ".github/workflows/docs.yml":
    "name: Docs\n# the starter's workflow, 121 lines in the real one\non: push\n",
  ".github/dependabot.yml": "version: 2\nupdates: []\n",
  ".gitignore": "dist/\n.generated/\nproject.schema.json\ndocument.schema.json\nnode_modules/\n",
  "README.md": "# The starter\n",
  "components/docs-callout.json": '{ "tagName": "docs-callout" }\n',
  "components/docs-footer.json": '{ "tagName": "docs-footer" }\n',
  "data/projects.snapshot.json": "{}\n",
  "docs.config.json": json({
    name: "Project Name",
    tagline: "A tagline.",
    slug: "project-name",
    platform: "general",
    repo: "https://github.com/Avunu/project-name",
    domain: "project-name.avunu.net",
    license: "MIT",
  }),
  "layouts/base.json": '{ "layout": "base" }\n',
  "package.json": json({
    name: "project-name-docs",
    private: true,
    scripts: { postinstall: "bun scripts/postinstall.ts", build: "bun scripts/build.ts" },
    dependencies: { "@jxsuite/compiler": "^5.0.0" },
    devDependencies: { "@jxsuite/server": "^4.4.3" },
  }),
  "project.json": json({
    name: "Project Name",
    url: "https://project-name.avunu.net",
    defaults: { layout: "./layouts/base.json" },
    extensions: ["@jxsuite/parser", "@jxsuite/search"],
  }),
  "public/.nojekyll": "",
  "public/CNAME": "project-name.avunu.net\n",
  "public/favicon.svg": "<svg/>\n",
  "scripts/build.ts": "export {};\n",
  "scripts/lib/stage.ts": "export {};\n",
};

/** The recorded starter of the synthetic template, as `loadLegacy` would give it for the real one. */
export async function syntheticLegacy(): Promise<Legacy> {
  const { canonicalSha256 } = await canonical();
  const parse = (name: string): unknown => JSON.parse(STARTER[name] as string);
  return {
    files: Object.fromEntries(Object.entries(STARTER).map(([path, text]) => [path, sha256(text)])),
    canonical: {
      "package.json": {
        ignore: ["name"],
        sha256: canonicalSha256(parse("package.json"), ["name"]),
      },
      "project.json": {
        ignore: ["name", "url"],
        sha256: canonicalSha256(parse("project.json"), ["name", "url"]),
      },
    },
  };
}

export const IDENTITY = {
  name: "Frappe Nix",
  tagline: "Reproducible Nix infrastructure for Frappe and ERPNext.",
  slug: "frappe_nix",
  platform: "nixos",
  repo: "https://github.com/Avunu/frappe-nix",
  domain: "frappe-nix.avunu.net",
  license: "MIT",
};

/** The Dependabot and auto-merge files of a pilot, before its migration (copies of the real ones). */
export const PILOT_NAMES = ["cloudflare-email-relay", "erpnext_taskview", "frappe-nix"] as const;

/**
 * The files of a repository that carries a copy of the starter (the synthetic template with this
 * project's values, as the pilots have it): everything under `docs-site/` that the starter has, the Bun
 * lockfile, the starter's workflow, a Dependabot file with the Bun entry, an auto-merge workflow, and
 * the Markdown. `files` adds to it or, with `null`, removes from it.
 */
export function starterClone(
  o: {
    files?: Record<string, string | null>;
    dependabot?: string;
    automerge?: string;
  } = {},
): TreeSpec {
  const site = "docs-site";
  const spec: Record<string, string> = {};
  for (const [path, text] of Object.entries(STARTER)) {
    if (path.startsWith(".github/")) continue;
    spec[`${site}/${path}`] = text;
  }
  // what differs by project: name, url, the configuration, the domain, the formatter's re-wrapping
  spec[`${site}/docs.config.json`] = json(IDENTITY);
  spec[`${site}/package.json`] = STARTER["package.json"]!.replace(
    "project-name-docs",
    "frappe-nix-docs",
  );
  spec[`${site}/project.json`] = JSON.stringify(
    {
      name: IDENTITY.name,
      url: `https://${IDENTITY.domain}`,
      defaults: { layout: "./layouts/base.json" },
      extensions: ["@jxsuite/parser", "@jxsuite/search"],
    },
    null,
    4,
  );
  spec[`${site}/public/CNAME`] = `${IDENTITY.domain}\n`;
  spec[`${site}/bun.lock`] = "# a lockfile\n";
  spec[".github/workflows/docs.yml"] = STARTER[".github/workflows/docs.yml"]!;
  spec[".github/dependabot.yml"] =
    o.dependabot ??
    [
      "version: 2",
      "updates:",
      "  - package-ecosystem: github-actions",
      "    directory: /",
      "    schedule:",
      "      interval: daily",
      "  - package-ecosystem: bun",
      "    directory: /docs-site",
      "    schedule:",
      "      interval: weekly",
      "",
    ].join("\n");
  spec[".github/workflows/dependabot-auto-merge.yml"] =
    o.automerge ??
    [
      "name: Dependabot auto-merge",
      "on: pull_request",
      "jobs:",
      "  auto-merge:",
      "    runs-on: ubuntu-latest",
      "    if: ${{ github.actor == 'dependabot[bot]' && !startsWith(github.head_ref, 'dependabot/bun/docs-site') }}",
      "    steps:",
      '      - run: gh pr merge --auto --squash "$PR_URL"',
      "",
    ].join("\n");
  spec["docs/README.md"] = "# Home\n";
  for (const [path, text] of Object.entries(o.files ?? {})) {
    if (text === null) delete spec[path];
    else spec[path] = text;
  }
  return spec;
}

/** A temporary clone (a folder with a `.git`, never a real repository: the tool does not run git). */
export function makeClone(spec: TreeSpec = starterClone()): string {
  const root = tempDir("docusystem-migrate-");
  mkdirSync(join(root, ".git"));
  writeTree(root, spec);
  return root;
}

/** Writes a file below `root`, creating folders. */
export function put(root: string, path: string, text: string): void {
  const file = join(root, ...path.split("/"));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}
