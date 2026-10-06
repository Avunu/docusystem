// Step 11 of the pipeline (section 5.1): fixes up `<root>/dist` after `jx build`, in place.
//   - whitespace: the emitter's separators between inline nodes and between highlighted code tokens
//     (tidy.ts).
//   - <title>: Jx writes the title text as it is, so a `<` in it ("Array<string>") is written raw;
//     it is escaped. (The package's own pages hand Jx the title already escaped, because the text
//     of a title can hold `</title>` and then cannot be told from the end of the element; this is
//     the repair for the `<` of a page of the shell's own, and assert.ts fails the build when a
//     `</title>` got through.)
//   - canonical URL and og:url: Jx writes them without the trailing slash the pages are served at.
//   - 404.html: GitHub Pages serves it for any unknown address (Jx writes it to 404/index.html).
//   - index.md: Jx writes a Markdown copy of every page next to it (the whole page, menus and search
//     included, with stray entities); nothing links to them and GitHub Pages would publish them, so
//     they are removed.
//   - links to repository files that are not pages (LICENSE, source folders) in the HTML of a page,
//     which Markdown staging cannot reach (a raw `<a href>`, an `<img src>`), become GitHub links.
//   - sitemap.xml: Jx lists pages without the trailing slash they are served at, lists the 404 page,
//     and stamps every URL with the build time; the sitemap is rewritten from the pages that exist,
//     on the configured domain.
//   - search-index.json: a page with no `title` in its frontmatter is indexed under its file name
//     ("README"); the index is given the title the page shows.
//   - code blocks whose language is not highlighted are reported (a warning, never a failure).
//
// What this step does not do: check the result. That is assert.ts (step 12), which asserts on the
// published files and not on what this module believes it did.
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { isInside, removeInside } from "./fsutil.js";
import { distFiles, fileFor, htmlPages, routeOfFile } from "./links.js";
import { publishNotFoundPage, tidyPage } from "./tidy.js";
import type { DocsConfig, NavData, PostbuildSummary, RepoLink } from "./types.js";

/** Languages that are plain text on purpose: no highlighting is expected for them. */
const PLAIN = new Set(["text", "txt", "plain", "plaintext", "none", "output", "log"]);

/** The languages of the code blocks of a page that were not highlighted (no `shiki` class), once each. */
export function unhighlightedLanguages(html: string): string[] {
  const found = new Set<string>();
  for (const m of html.matchAll(/<code\b[^>]*\bclass="([^"]*)"/g)) {
    const classes = m[1]!.split(/\s+/);
    const language = classes.find((c) => c.startsWith("language-"))?.slice("language-".length);
    if (language && !classes.includes("shiki") && !PLAIN.has(language.toLowerCase()))
      found.add(language);
  }
  return [...found].sort();
}

/**
 * Escapes `<`, `>` and a lone `&` in the text of <title>, which Jx writes unescaped. The text runs to
 * the first `</title>`, so this cannot repair a title that holds one (the rest of it would be left
 * as markup): pages/[...path].json escapes its titles before Jx writes them for that reason, and an
 * override page that puts text it does not control in its title must do the same. The check of the
 * result is titleHoldsMarkup in assert.ts.
 */
export function escapeTitle(html: string): string {
  return html.replace(
    /<title>([\s\S]*?)<\/title>/,
    (_m, text: string) =>
      `<title>${text
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll(/&(?![a-z][a-z0-9]*;|#\d+;|#x[\da-f]+;)/gi, "&amp;")}</title>`,
  );
}

/**
 * Removes the Markdown copy Jx writes beside each page (`index.md` next to `index.html`). An
 * `index.md` with no page beside it is somebody's file and stays. Returns how many were removed.
 */
export function dropMarkdownCopies(dist: string): number {
  const files = new Set(distFiles(dist));
  let removed = 0;
  for (const file of files) {
    if (file !== "index.md" && !file.endsWith("/index.md")) continue;
    if (!files.has(`${file.slice(0, -"index.md".length)}index.html`)) continue;
    removeInside(join(dist, ...file.split("/")), dist);
    removed++;
  }
  return removed;
}

function setAttribute(tag: string, attribute: string, value: string): string {
  return tag.replace(new RegExp(`(\\s${attribute}=)(?:"[^"]*"|'[^']*')`), `$1"${value}"`);
}

/** Sets the canonical link and og:url to the served address; other origins are left alone. */
export function fixCanonical(html: string, route: string, site: string): string {
  const want = new URL(route, `${site}/`).href;
  const ours = (value: string | undefined): boolean => !value || value.startsWith(site);
  let out = html.replace(/<link\b[^>]*\brel=["']canonical["'][^>]*>/i, (tag) => {
    const current = /\shref="([^"]*)"/.exec(tag)?.[1];
    return ours(current) ? setAttribute(tag, "href", want) : tag;
  });
  out = out.replace(/<meta\b[^>]*\bproperty=["']og:url["'][^>]*>/i, (tag) => {
    const current = /\scontent="([^"]*)"/.exec(tag)?.[1];
    return ours(current) ? setAttribute(tag, "content", want) : tag;
  });
  return out;
}

const escapeXml = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** sitemap.xml for the pages that can be indexed: one <loc> per page, at the address it is served at. */
export function sitemapXml(site: string, routes: string[]): string {
  const urls = routes.map(
    (route) => `  <url>\n    <loc>${escapeXml(new URL(route, `${site}/`).href)}</loc>\n  </url>`,
  );
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
}

/** Whether the page asks search engines to stay away. */
export function isNoindex(html: string): boolean {
  return /<meta\b[^>]*\bname=["']robots["'][^>]*\bcontent=["'][^"']*noindex/i.test(html);
}

interface SearchDocument {
  url?: string;
  title?: string;
  description?: string;
}

/**
 * Gives every document of the search index the title (and, when it has none, the description) of
 * the page it belongs to. `pages` is keyed by page URL (`/docs/guide/`). Returns the index unchanged,
 * with a count of zero, when it is not the shape Jx writes today.
 */
export function fixSearchIndex(
  raw: string,
  pages: Record<string, { title: string; description: string }>,
): { text: string; changed: number } {
  let index: { documents?: SearchDocument[] };
  try {
    index = JSON.parse(raw) as { documents?: SearchDocument[] };
  } catch {
    return { text: raw, changed: 0 };
  }
  if (!Array.isArray(index.documents)) return { text: raw, changed: 0 };
  let changed = 0;
  for (const doc of index.documents) {
    if (typeof doc.url !== "string") continue;
    const key = doc.url.split("#")[0]!;
    if (!Object.hasOwn(pages, key)) continue;
    const page = pages[key]!;
    if (doc.title !== page.title) {
      doc.title = page.title;
      changed++;
    }
    if (!doc.description && page.description) doc.description = page.description;
  }
  return { text: JSON.stringify(index), changed };
}

// ---- Links to repository files, in the HTML of a page ----
//
// Markdown links to repository files are rewritten while the documents are staged (step 5, which also
// builds GitHub addresses). What staging cannot reach is the HTML of a page: a raw `<a href>` or
// `<img src>` that Jx copies as written. This is the repair for those. It resolves a link the way
// staging does (next to the Markdown file first, then at the repository root) and builds the same
// addresses, but it is kept here, with no import from the content modules, so that the output package
// compiles and tests on its own. Once both packages are merged the two can share one implementation.

/** What the repair of repository links needs to know. */
export interface RepoLinkContext {
  /** The site's dist/ folder: a link that already resolves there is left alone. */
  dist: string;
  /** The repository root. */
  repoRoot: string;
  /** The folder the Markdown lives in. */
  docsDir: string;
  /** https://github.com/<owner>/<name> */
  repoUrl: string;
  branch: string;
}

const entities = (value: string): string =>
  value.replaceAll("&amp;", "&").replaceAll("&quot;", '"').replaceAll("&#39;", "'");
const encodeAttribute = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");

/** The repository path (relative to the repo root, `/`-separated) a link points at, or null. */
export function repoTarget(
  href: string,
  sourceDir: string,
  ctx: Pick<RepoLinkContext, "repoRoot" | "docsDir">,
): string | null {
  const bare = href.split("#")[0]!.split("?")[0]!;
  if (
    bare === "" ||
    bare.startsWith("/") ||
    /^[a-z][a-z0-9+.-]*:/i.test(bare) ||
    bare.startsWith("//")
  )
    return null;
  let decoded = bare;
  try {
    decoded = decodeURIComponent(bare);
  } catch {
    // keep the raw text
  }
  // Next to the document first, then at the repository root (a README copied into docs/ is written
  // relative to the root).
  for (const base of [join(ctx.docsDir, sourceDir), ctx.repoRoot]) {
    const candidate = resolve(base, decoded);
    if (isInside(ctx.repoRoot, candidate) && existsSync(candidate)) {
      return relative(ctx.repoRoot, candidate).split(sep).join("/");
    }
  }
  return null;
}

/** The GitHub address of a repository path: `/blob/` for a file, `/tree/` for a folder, `/raw/` for an image. */
export function githubUrl(
  ctx: Pick<RepoLinkContext, "repoUrl" | "branch" | "repoRoot">,
  repoPath: string,
  asset: boolean,
): string {
  const isDir = repoPath === "" || existsDirectory(join(ctx.repoRoot, repoPath));
  const kind = asset && !isDir ? "raw" : isDir ? "tree" : "blob";
  const path =
    repoPath === ""
      ? ""
      : `/${posix.normalize(repoPath).split("/").map(encodeURIComponent).join("/")}`;
  return `${ctx.repoUrl}/${kind}/${ctx.branch}${path}`;
}

function existsDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Rewrites the repository-relative links of one page that do not resolve in the built site, in
 * `<a href>` and `<img src>`: a link to a file or folder of the repository becomes its GitHub
 * address, and anything else is left for the link crawl to report. `route` is the page's address
 * and `sourceDir` the folder of its Markdown file inside docs/ ("" at the top). Returns the new HTML
 * and the links it changed.
 */
export function rewriteRepoLinks(
  html: string,
  route: string,
  sourceDir: string,
  ctx: RepoLinkContext,
): { html: string; links: RepoLink[] } {
  const links: RepoLink[] = [];
  const out = html.replace(/<(a|img)\b([^>]*)>/gi, (tag, name: string, attrs: string) => {
    const attribute = name.toLowerCase() === "a" ? "href" : "src";
    const match = new RegExp(`\\s${attribute}=("([^"]*)"|'([^']*)')`).exec(attrs);
    if (!match) return tag;
    const value = entities(match[2] ?? match[3] ?? "");
    if (
      value === "" ||
      value.startsWith("#") ||
      /^[a-z][a-z0-9+.-]*:/i.test(value) ||
      value.startsWith("/")
    )
      return tag;
    // Resolves in the built site (a page, a copied image, an anchor): leave it alone.
    const bare = value.split("#")[0]!.split("?")[0]!;
    const served = posix.join(route.endsWith("/") ? route : `${posix.dirname(route)}/`, bare);
    if (
      bare !== "" &&
      fileFor(ctx.dist, served + (bare.endsWith("/") && !served.endsWith("/") ? "/" : ""))
    )
      return tag;
    const target = repoTarget(value, sourceDir, ctx);
    if (target === null) return tag;
    const hash = value.includes("#") ? `#${value.split("#").slice(1).join("#")}` : "";
    const url = githubUrl(ctx, target, attribute === "src") + hash;
    links.push({ page: route, from: value, to: url });
    return tag.replace(match[0], ` ${attribute}="${encodeAttribute(url)}"`);
  });
  return { html: out, links };
}

// ---- The step ----

/**
 * Step 11: fixes the Jx output in `dist`. `config.branch` is the resolved branch (it feeds the GitHub
 * addresses), `nav` is the sidebar data of step 7 (page titles, and the Markdown file of each page for
 * its repository links), `o` the repository root and the Markdown folder. Throws when `dist` does not
 * exist; everything else it finds is a warning in the summary. Run it once on a fresh Jx output (the
 * pipeline recreates the root and its `dist/` every time): see fixHighlightedCode in tidy.ts.
 */
export function runPostbuild(
  dist: string,
  config: DocsConfig & { branch: string },
  nav: NavData,
  o: { repoRoot: string; docsDir: string },
): PostbuildSummary {
  if (!existsSync(dist)) throw new Error(`${dist} does not exist: the build produced nothing`);
  const site = `https://${config.domain}`;
  const notFound = publishNotFoundPage(dist) || existsSync(join(dist, "404.html"));
  const files = htmlPages(dist);
  let canonicals = 0;
  const repoLinks: RepoLink[] = [];
  const indexable: string[] = [];
  const warnings: string[] = [];
  for (const file of files) {
    const route = routeOfFile(dist, file);
    const before = readFileSync(file, "utf8");
    let after = escapeTitle(tidyPage(before));
    const plain = unhighlightedLanguages(after);
    if (plain.length > 0) {
      warnings.push(
        `${route}: code in ${plain.join(", ")} is shown without highlighting (the language is not one the build knows; the code itself is unchanged)`,
      );
    }
    const source = Object.hasOwn(nav.pages, route) ? nav.pages[route]!.edit : undefined;
    if (source !== undefined) {
      const sourceDir = dirname(source) === "." ? "" : dirname(source);
      const rewritten = rewriteRepoLinks(after, route, sourceDir, {
        dist,
        repoRoot: o.repoRoot,
        docsDir: o.docsDir,
        repoUrl: config.repo,
        branch: config.branch,
      });
      after = rewritten.html;
      repoLinks.push(...rewritten.links);
    }
    if (route !== "/404.html") {
      const fixed = fixCanonical(after, route, site);
      if (fixed !== after) canonicals++;
      after = fixed;
      if (!isNoindex(after)) indexable.push(route);
    }
    if (after !== before) writeFileSync(file, after);
  }
  writeFileSync(join(dist, "sitemap.xml"), sitemapXml(site, indexable));
  const markdownCopies = dropMarkdownCopies(dist);

  let searchTitles = 0;
  const searchFile = join(dist, "search-index.json");
  if (existsSync(searchFile)) {
    const fixed = fixSearchIndex(readFileSync(searchFile, "utf8"), nav.pages);
    searchTitles = fixed.changed;
    if (fixed.changed > 0) writeFileSync(searchFile, fixed.text);
  }

  return {
    pages: files.length,
    warnings,
    markdownCopies,
    sitemapUrls: indexable.length,
    searchTitles,
    repoLinks,
    canonicals,
    cname: existsSync(join(dist, "CNAME")),
    notFound,
  };
}
