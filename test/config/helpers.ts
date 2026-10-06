import { join } from "node:path";
import type { Catalog } from "../../src/lib/types.js";
import { tempDir, writeTree, type TreeSpec } from "../support/index.js";

/** A valid configuration (the seven identity keys): the starting point of most tests. */
export const GOOD = {
  name: "Example",
  tagline: "A sample project for the tests.",
  slug: "example_project",
  platform: "general",
  repo: "https://github.com/Avunu/docusystem-example",
  domain: "example-project.avunu.net",
  license: "MIT",
} as const;

/**
 * A repository in a temporary folder: a `.git` folder, `docs-site/docusystem.config.json` (the
 * configuration is written as given, or not at all when `config` is null) and `docs/README.md` (not
 * when `home` is false). `files` are added (and may replace those) by `/`-separated path from the
 * repository root.
 */
export function shell(o: { config?: unknown; home?: boolean; files?: TreeSpec } = {}): {
  repo: string;
  site: string;
  docs: string;
} {
  const repo = tempDir();
  const spec: TreeSpec = { ".git/HEAD": "ref: refs/heads/main\n" };
  if (o.home !== false) spec["docs/README.md"] = "# Home\n";
  if (o.config !== null) {
    spec["docs-site/docusystem.config.json"] = JSON.stringify(o.config ?? GOOD, null, 2);
  }
  writeTree(repo, { ...spec, ...o.files });
  return { repo, site: join(repo, "docs-site"), docs: join(repo, "docs") };
}

// ---- the project catalog ----

/** One project of the catalog, as avunu.net publishes it. */
export const entry = (over: Record<string, unknown> = {}) => ({
  slug: "frappe-nix",
  title: "frappe-nix",
  platform: "nixos",
  summary: "One sentence.",
  repo: "https://github.com/Avunu/frappe-nix",
  page: "https://avunu.net/open-source/frappe-nix/",
  docs: null,
  license: "MIT",
  status: "active",
  suite: null,
  ...over,
});

export const catalog = (projects: unknown[] = [entry()]): Catalog =>
  ({
    version: 1,
    generated: "2026-10-05T00:00:00Z",
    site: "https://avunu.net",
    projects,
  }) as Catalog;
