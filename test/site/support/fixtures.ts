// The documentation fixture of the site tests: test/site/fixtures/docs, the navigation recorded for
// it (nav.json) and what each file of it must become. The table is the contract between three
// parties that each compute it on their own: the `docs` content type of project.base.json (Jx),
// the helpers of docs.ts (WP3) and the sidebar of nav.ts (WP3).
import { join } from "node:path";
import { SITE_FIXTURES } from "./site.js";

/** The folder that is staged as the documentation. */
export const DOCS_FIXTURE: string = join(SITE_FIXTURES, "docs");

/** The sidebar data that nav.ts produced for DOCS_FIXTURE (see fixtures/README.md). */
export const NAV_FIXTURE: string = join(SITE_FIXTURES, "nav.json");

/** The project the fixture site documents. */
export const FIXTURE_CONFIG = {
  name: "Example Project",
  tagline: "A fixture that stands in for a project.",
  slug: "example",
  platform: "general",
  repo: "https://github.com/Avunu/example",
  domain: "example.avunu.net",
  license: "MIT",
  branch: "main",
  docsPath: "docs",
} as const;

export type DocFixture =
  | { file: string; route: string }
  | { file: string; route?: undefined; left: string };

/** Every file of DOCS_FIXTURE: the route it is published at, or why it is left out. */
export const DOC_FIXTURES: readonly DocFixture[] = [
  { file: "README.md", route: "/docs/" },
  { file: "faq/general.md", route: "/docs/faq/general/" },
  { file: "faq/readme.md", route: "/docs/faq/" },
  { file: "getting-started.md", route: "/docs/getting-started/" },
  { file: "guides/Configuration Options.md", route: "/docs/guides/configuration-options/" },
  { file: "guides/README.md", route: "/docs/guides/" },
  { file: "guides/install.md", route: "/docs/guides/install/" },
  { file: "reference/advanced/index.md", route: "/docs/reference/advanced/" },
  { file: "reference/advanced/internals.md", route: "/docs/reference/advanced/internals/" },
  { file: "reference/api.md", route: "/docs/reference/api/" },
  { file: "_partials/footer.md", left: "a folder whose name starts with _" },
  { file: "_private.md", left: "a file whose name starts with _" },
  { file: ".hidden/secret.md", left: "a folder whose name starts with a dot" },
  { file: "draft.md", left: "draft: true" },
  { file: "unpublished.md", left: "publish: false" },
];

/** The routes of the documentation, sorted. */
export const DOC_ROUTES: string[] = DOC_FIXTURES.flatMap((f) => (f.route ? [f.route] : [])).sort();
