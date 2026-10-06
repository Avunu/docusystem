// The documentation files as the site sees them: which Markdown files are pages, what each is
// called and where it is published. The rules mirror the `docs` content type in
// site/project.base.json (exclude, where, route, indexRoute), because nav.ts writes the sidebar
// before Jx loads the same files. Two checks keep the mirror honest: test/content/jx-agreement.test.ts
// runs these functions and Jx's own over the same inputs, and the link crawl of `docusystem check`
// fails when a sidebar link is not a page.
import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { firstHeading, firstParagraph, parseFrontmatter } from "./frontmatter.js";
import { humanize, slugifyPath } from "./slug.js";
import type { DocFile } from "./types.js";

export type { DocFile };

/** Where the documentation is published on the site (the `route` templates in project.base.json). */
export const DOCS_PREFIX = "/docs";

/** `README` and `index` stand for their folder (the Jx rule, for any case). */
export function isIndexName(file: string): boolean {
  return /^(?:index|readme)\.[^./]+$/i.test(file);
}

/**
 * Whether a path (relative to the documentation folder, `/`-separated) is left out of the
 * collection: dot files and folders, `_`-prefixed files and folders, and node_modules. The `exclude`
 * list of the docs content type in site/project.base.json says the same in glob form.
 */
export function isExcluded(rel: string): boolean {
  return rel
    .split("/")
    .some((part) => part.startsWith(".") || part.startsWith("_") || part === "node_modules");
}

/**
 * Whether a field equals `value` the way Jx's `where` reads it: it is the value, or it is a list
 * that holds it (`draft: [true]` counts as `draft: true`).
 */
const holds = (actual: unknown, value: boolean): boolean =>
  actual === value || (Array.isArray(actual) && actual.includes(value));

/**
 * The `where` clause of the docs content type (`{draft: {$ne: true}, publish: {$ne: false}}`):
 * `draft: true` and `publish: false` keep a page out; any other value, including text such as
 * "true", leaves it in.
 */
export function isPublished(data: Record<string, unknown>): boolean {
  return !holds(data.draft, true) && !holds(data.publish, false);
}

const byName = (a: { name: string }, b: { name: string }): number =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

/**
 * The Markdown files below `root` that the collection reads, relative and `/`-separated, in the
 * order Jx reads them (by name within each folder). Links are not followed: the folder is the staged
 * copy, which holds real files only, and a link in it is not content.
 */
function markdownFiles(root: string, dir = ""): string[] {
  const out: string[] = [];
  const here = dir === "" ? root : join(root, ...dir.split("/"));
  for (const entry of readdirSync(here, { withFileTypes: true }).toSorted(byName)) {
    const rel = dir === "" ? entry.name : `${dir}/${entry.name}`;
    if (isExcluded(rel)) continue;
    if (entry.isDirectory()) out.push(...markdownFiles(root, rel));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) out.push(rel);
  }
  return out;
}

/**
 * Reads every published page under `root` (the staged copy of the documentation). Files come back
 * in the order Jx reads them. Throws a FrontmatterError, naming the file, when a page's frontmatter
 * is not usable.
 */
export function readDocs(root: string): DocFile[] {
  const files: DocFile[] = [];
  for (const rel of markdownFiles(root)) {
    const { data, body } = parseFrontmatter(
      readFileSync(join(root, rel.split("/").join(sep)), "utf8"),
      rel,
    );
    if (!isPublished(data)) continue;
    const slash = rel.lastIndexOf("/");
    const name = rel.slice(slash + 1);
    files.push({
      rel,
      dir: slash === -1 ? "" : rel.slice(0, slash),
      base: name.replace(/\.[^.]+$/, ""),
      isIndex: isIndexName(name),
      data,
      body,
    });
  }
  return files;
}

/** The URL a file is published at: `route` for a page, `indexRoute` for a folder's README. */
export function urlFor(file: Pick<DocFile, "dir" | "base" | "isIndex">): string {
  const path = file.isIndex
    ? slugifyPath(file.dir)
    : slugifyPath(file.dir ? `${file.dir}/${file.base}` : file.base);
  return `${DOCS_PREFIX}/${path ? `${path}/` : ""}`;
}

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/** frontmatter `title`, else the first `# Heading`, else the file or folder name. */
export function titleOf(file: DocFile, homeName = "Documentation"): string {
  const fromFrontmatter = text(file.data.title);
  if (fromFrontmatter) return fromFrontmatter;
  const heading = firstHeading(file.body);
  if (heading) return heading;
  if (file.isIndex) {
    const folder = file.dir.slice(file.dir.lastIndexOf("/") + 1);
    return folder ? humanize(folder) : homeName;
  }
  return humanize(file.base);
}

/** The sidebar label: frontmatter `nav_title`, else the title. */
export function labelOf(file: DocFile, homeName?: string): string {
  return text(file.data.nav_title) || titleOf(file, homeName);
}

/** frontmatter `description`, else the first paragraph of the page. */
export function descriptionOf(file: DocFile): string {
  return text(file.data.description) || firstParagraph(file.body);
}

/** frontmatter `order` as a number, or Infinity when absent (pages without one sort last). */
export function orderOf(file: Pick<DocFile, "data">): number {
  const value = file.data.order;
  return typeof value === "number" && Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
}
