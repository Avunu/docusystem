// The types that more than one module shares (Appendix B of the architecture decision record). They
// live here so that the work packages can be written and tested against each other from day one.
// Types that only one module uses stay in that module.
import type { Platform } from "./platforms.js";

export type { Platform };

/** The contents of docusystem.config.json, as validated. */
export interface DocsConfig {
  name: string;
  tagline: string;
  slug: string;
  platform: Platform;
  repo: string;
  domain: string;
  license: string;
  branch?: string;
  docs?: string;
  theme?: { light?: Record<string, string>; dark?: Record<string, string> };
  images?: "optimize" | "off";
  jx?: Record<string, unknown>;
}

/** Every folder and file a run reads or writes, all absolute. */
export interface Paths {
  /** The folder with docusystem.config.json and package.json. */
  siteDir: string;
  /** The repository root: the nearest ancestor of the site folder with a `.git`. */
  repoRoot: string;
  /** The Markdown folder. */
  docsDir: string;
  /** <siteDir>/.docusystem: everything the CLI generates; ignored by git. */
  work: string;
  /** <work>/site: the assembled Jx project root. */
  root: string;
  /** <root>/.generated/docs: the staged copy of the Markdown (what Jx reads as the `docs` content type). */
  stagedDocs: string;
  /** <root>/.generated/nav.json: the sidebar, previous/next and landing cards. */
  navFile: string;
  /** <root>/dist: Jx's output, post-processed in place. */
  jxDist: string;
  /** <siteDir>/dist: the published copy; the only path CI uploads. */
  dist: string;
  /** <work>/serve: dev only, the copy of dist that the dev server answers from. */
  serve: string;
  /** <work>/manifest.json */
  manifest: string;
  /** <work>/jx.log */
  jxLog: string;
  /** <work>/lock: the pid file. */
  lock: string;
}

/** Where a file of the assembled root came from. */
export type Origin = "package" | "override" | "generated";

/** `<work>/manifest.json`: the record of what the last assemble put in the root. */
export interface Manifest {
  docusystem: string;
  runtime: string;
  jx: Record<string, string>;
  files: Record<string, Origin>;
  shadowed: string[];
  added: string[];
  catalog: "bundled" | "live";
  strict: boolean;
}

/** One thing a run found wrong (or worth saying), with its location when it has one. */
export interface Problem {
  level: "error" | "warning";
  message: string;
  file?: string;
  line?: number;
}

/** One line of a checklist (`doctor`). */
export interface Finding {
  level: "ok" | "warning" | "error";
  message: string;
}

/**
 * A path a walk left out. `path` is relative to the walked folder and `/`-separated; `reason` is a
 * noun phrase that completes the sentence "<path> is <reason>: not published", for example
 * "a symbolic link outside the repository".
 */
export interface SkippedPath {
  path: string;
  reason: string;
}

/** The result of `fsutil.walkFiles`. */
export interface WalkResult {
  /** Files, relative to the walked folder, `/`-separated, sorted. */
  files: string[];
  skipped: SkippedPath[];
}

/** One positive assertion about a built site (`assert:`). */
export interface Assertion {
  ok: boolean;
  message: string;
}

// ---- Content (WP3) ----

/** A documentation file as the site sees it (docs.ts). */
export interface DocFile {
  /** Path inside docs/, `/`-separated, with the extension: `guides/Configuration.md`. */
  rel: string;
  /** Folder inside docs/ (`""` at the top), `/`-separated. */
  dir: string;
  /** File name without the extension. */
  base: string;
  /** README.md or index.md: the page that stands for its folder. */
  isIndex: boolean;
  data: Record<string, unknown>;
  body: string;
}

export interface NavLink {
  label: string;
  url: string;
}

export interface NavGroup {
  label: string;
  /** The folder's own page, when it has a README: the group's heading is not a link, the first item is. */
  url: string | null;
  /** Every page URL inside, so the layout can open the group that holds the current page. */
  urls: string[];
  pages: NavLink[];
}

export interface NavSection extends NavGroup {
  groups: NavGroup[];
}

export interface PageInfo {
  title: string;
  description: string;
  /** The section (top-level folder) the page is in, for the eyebrow; empty for top-level pages. */
  section: string;
  prev: { title: string; url: string } | null;
  next: { title: string; url: string } | null;
  /** The file inside docs/, for the "Edit this page" link. */
  edit: string;
}

/** `<root>/.generated/nav.json` (nav.ts). */
export interface NavData {
  home: NavLink;
  loose: NavLink[];
  sections: NavSection[];
  /** Few pages: every section starts open. Many: only the one holding the current page. */
  expandAll: boolean;
  pages: Record<string, PageInfo>;
  /** Reading order, home first: what previous/next walk. */
  flat: Array<{ title: string; url: string }>;
  /** Cards for the landing page: the first pages after the home page. */
  featured: Array<{ title: string; description: string; url: string; section: string }>;
}

/** A link of a document that staging rewrote (stage.ts). */
export interface StagedLink {
  /** The file inside docs/ that holds the link. */
  file: string;
  /** 1-based line. */
  line: number;
  from: string;
  to: string;
}

export interface StageResult {
  files: number;
  written: number;
  removed: number;
  links: StagedLink[];
  /** Files whose leading comment was moved behind the frontmatter. */
  comments: string[];
  /** Symbolic links that were not published (fsutil's symlink policy); an error under strict. */
  skipped: SkippedPath[];
}

export interface LintIssue {
  /** Path inside docs/, `/`-separated. */
  file: string;
  /** 1-based line in the file. */
  line: number;
  level: "error" | "warning";
  rule: string;
  message: string;
}

// ---- Output (WP4) ----

/** A link from a page to a repository file that postbuild turned into a GitHub link. */
export interface RepoLink {
  page: string;
  from: string;
  to: string;
}

export interface PostbuildSummary {
  pages: number;
  warnings: string[];
  markdownCopies: number;
  sitemapUrls: number;
  searchTitles: number;
  repoLinks: RepoLink[];
  canonicals: number;
  cname: boolean;
  notFound: boolean;
}

export interface LinkIssue {
  page: string;
  message: string;
}

export interface LinkReport {
  pages: number;
  checked: number;
  errors: LinkIssue[];
  warnings: LinkIssue[];
}

/** A tinted highlight: `color-mix(in srgb, var(--token) 22%, transparent)`. */
export interface Highlight {
  token: string;
  percent: number;
  /** The text colours it can sit behind: the rule's own `color`, or (inherited) the row's title and excerpt colours. */
  text: string[];
}

export interface Failure {
  theme: "light" | "dark";
  label: string;
  ratio: number;
  minimum: number;
}

// ---- Catalog (WP1) ----

/**
 * One project of avunu.net's projects.json (version 1): `platform` is one of the PLATFORMS and `docs`
 * is null until the project has a docs site.
 */
export interface CatalogProject {
  slug: string;
  title: string;
  platform: string;
  summary: string;
  repo: string;
  page: string;
  docs: string | null;
  license: string | null;
  status: string;
  suite: string | null;
}

/** The catalog document: https://avunu.net/projects.json, version 1. */
export interface Catalog {
  version: 1;
  generated: string;
  site: string;
  projects: CatalogProject[];
}
