// Catalog documents (https://avunu.net/projects.json, version 1) for the tests of the project
// switcher. The bundled catalog is WP1's (site/data/); these are small made-up ones, so the tests
// do not depend on what the real catalog lists on the day they run.
import type { Catalog, CatalogProject } from "../../../src/lib/types.js";

/** A catalog document around `projects` (anything: tests also feed it malformed entries). */
export const catalog = (projects: unknown[]): Catalog =>
  ({
    version: 1,
    generated: "2026-10-05T00:00:00Z",
    site: "https://avunu.net",
    projects,
  }) as Catalog;

/** One well-formed entry; `extra` overrides any field. */
export const entry = (
  slug: string,
  platform: string,
  extra: Record<string, unknown> = {},
): CatalogProject =>
  ({
    slug,
    title: slug.toUpperCase(),
    platform,
    summary: "s",
    repo: `https://github.com/Avunu/${slug}`,
    page: `https://avunu.net/open-source/${slug}/`,
    docs: null,
    license: "MIT",
    status: "active",
    suite: null,
    ...extra,
  }) as CatalogProject;

/** Five projects on four platforms, one of them (`example`) the project the fixture site documents. */
export const SAMPLE_CATALOG: Catalog = catalog([
  entry("example", "general", { title: "Example Project", docs: "https://example.avunu.net" }),
  entry("alpha", "frappe", { title: "Alpha Desk", docs: "https://alpha.avunu.net" }),
  entry("beta", "frappe", { title: "Beta Ledger" }),
  entry("gamma", "odoo", { title: "Gamma Shop" }),
  entry("delta", "nixos", { title: "Delta Modules", docs: "https://delta.avunu.net" }),
]);
