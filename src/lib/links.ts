// The link crawl of `docusystem check` (step 16 of the pipeline, section 5.1) and the helpers that
// the other output modules share (the pages of a built site, the address a file is served at, the
// links a page holds). It reads every built page and proves that whatever links to something finds
// it: pages, anchors, assets, search results and sidebar entries. Pure over a `dist/` folder, so the
// tests run it on small fixtures.
//
// A built site is real files (invariant 5): the walk lists regular files and folders and never
// follows a link, so nothing outside `dist/` is ever read through one.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, posix, relative } from "node:path";
import type { LinkIssue, LinkReport, NavData } from "./types.js";

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  quot: '"',
  apos: "'",
  lt: "<",
  gt: ">",
  nbsp: "\u00a0",
};

/** Decodes the named entities that a build writes (`&amp;`, `&quot;`, `&apos;`, `&lt;`, `&gt;`, `&nbsp;`) and the numeric ones. */
export function decodeEntities(value: string): string {
  return value.replaceAll(
    /&(?:#(\d{1,7})|#[xX]([\da-fA-F]{1,6})|([a-z]+));/g,
    (whole, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
      if (name !== undefined) return NAMED_ENTITIES[name] ?? whole;
      const code = dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex ?? "", 16);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code)
        : whole;
    },
  );
}

/** Every file under `dist`, relative to it and `/`-separated, sorted; links are not followed. */
export function distFiles(dist: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name), `${prefix}${entry.name}/`);
      else if (entry.isFile()) out.push(`${prefix}${entry.name}`);
    }
  };
  walk(dist, "");
  return out.sort();
}

/**
 * The built pages: every `.html` file under `dist`, absolute, sorted by path (so the order is the
 * same on every machine; the sitemap lists pages in this order, as the starter's did).
 */
export function htmlPages(dist: string): string[] {
  return distFiles(dist)
    .filter((file) => file.endsWith(".html"))
    .map((file) => join(dist, ...file.split("/")));
}

/** The address a built file is served at: dist/docs/a/index.html is /docs/a/, dist/404.html is /404.html. */
export function routeOfFile(dist: string, file: string): string {
  const rel = relative(dist, file).split("\\").join("/");
  return `/${rel.replace(/(?:^|\/)index\.html$/, (match) => (match.startsWith("/") ? "/" : ""))}`;
}

/** Markup that can contain text that only looks like links. */
export function visibleMarkup(html: string): string {
  return html
    .replaceAll(/<(script|style|template)\b[\s\S]*?<\/\1>/gi, "")
    .replaceAll(/<!--[\s\S]*?-->/g, "");
}

/**
 * A template expression that was not evaluated at build time shows as literal text on the page
 * (`${state.config.data.name}`). Code samples cannot trigger this: Jx writes a literal "${" in code
 * as "&#36;{". Returns the first one in `html` (up to its closing brace, if it has one), or null.
 */
export function strayExpression(html: string): string | null {
  return (
    /\$\u200b?\{\s*(?:state|\$map|item|index)\b[^}]*\}?/.exec(visibleMarkup(html))?.[0] ?? null
  );
}

export function idsOf(html: string): Set<string> {
  const ids = new Set<string>();
  for (const m of visibleMarkup(html).matchAll(/\s(?:id|name)=("([^"]*)"|'([^']*)')/g))
    ids.add(decodeEntities(m[2] ?? m[3] ?? ""));
  return ids;
}

export interface Reference {
  attribute: "href" | "src";
  value: string;
  tag: string;
}

export function referencesOf(html: string): Reference[] {
  const refs: Reference[] = [];
  for (const m of visibleMarkup(html).matchAll(/<([a-zA-Z][\w-]*)\b([^>]*)>/g)) {
    const tag = m[1]!.toLowerCase();
    for (const a of m[2]!.matchAll(/\s(href|src)=("([^"]*)"|'([^']*)')/g)) {
      refs.push({
        attribute: a[1] as "href" | "src",
        value: decodeEntities(a[3] ?? a[4] ?? ""),
        tag,
      });
    }
  }
  return refs;
}

const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Resolves a reference found on `route` to a path (always starting with /) and a fragment. */
export function resolveReference(
  route: string,
  value: string,
): { path: string; hash: string; query: string } | null {
  if (value === "" || EXTERNAL.test(value)) return null;
  const hashAt = value.indexOf("#");
  const hash = hashAt === -1 ? "" : value.slice(hashAt + 1);
  const rest = hashAt === -1 ? value : value.slice(0, hashAt);
  const queryAt = rest.indexOf("?");
  const query = queryAt === -1 ? "" : rest.slice(queryAt);
  const pathPart = queryAt === -1 ? rest : rest.slice(0, queryAt);
  let path: string;
  if (pathPart === "") path = route;
  else if (pathPart.startsWith("/")) path = pathPart;
  else
    path =
      posix.join(route.endsWith("/") ? route : `${posix.dirname(route)}/`, pathPart) +
      (pathPart.endsWith("/") ? "/" : "");
  // An undecodable path is left as it is: it will not resolve, and it is reported.
  path = safeDecode(path);
  const normal = posix.normalize(path);
  return {
    path: normal + (path.endsWith("/") && !normal.endsWith("/") ? "/" : ""),
    hash: safeDecode(hash),
    query,
  };
}

/**
 * The built file a path (starting with `/`, decoded) is served from, or null. `exact` is false when
 * the path names a folder without its trailing slash: GitHub Pages redirects it, so it works, and
 * the crawl warns.
 */
export function fileFor(dist: string, path: string): { file: string; exact: boolean } | null {
  const clean = path.replace(/^\//, "");
  if (path.endsWith("/")) {
    const index = join(dist, clean, "index.html");
    return existsSync(index) ? { file: index, exact: true } : null;
  }
  const direct = join(dist, clean);
  if (existsSync(direct) && statSync(direct).isFile()) return { file: direct, exact: true };
  const index = join(dist, clean, "index.html");
  if (existsSync(index)) return { file: index, exact: false };
  return null;
}

/** Every URL the sidebar data links to or describes. */
function navUrls(nav: NavData): Set<string> {
  const urls = new Set<string>([
    nav.home.url,
    ...nav.flat.map((f) => f.url),
    ...Object.keys(nav.pages),
  ]);
  for (const l of nav.loose) urls.add(l.url);
  for (const s of nav.sections) {
    for (const l of s.pages) urls.add(l.url);
    for (const g of s.groups) for (const l of g.pages) urls.add(l.url);
  }
  return urls;
}

/**
 * Step 16: crawls a built site. Errors fail `check`; warnings are printed. With `nav` the sidebar is
 * crawled too: every entry must have been built, and every built documentation page must be in it
 * (docusystem computes the sidebar and Jx builds the pages, and the two must agree).
 */
export function checkLinks(dist: string, options: { nav?: NavData } = {}): LinkReport {
  const report: LinkReport = { pages: 0, checked: 0, errors: [], warnings: [] };
  const pages = htmlPages(dist);
  report.pages = pages.length;
  const idCache = new Map<string, Set<string>>();
  const idsFor = (file: string): Set<string> => {
    let ids = idCache.get(file);
    if (!ids) idCache.set(file, (ids = idsOf(readFileSync(file, "utf8"))));
    return ids;
  };
  const err = (page: string, message: string): void => {
    report.errors.push({ page, message });
  };
  const warn = (page: string, message: string): void => {
    report.warnings.push({ page, message });
  };

  for (const file of pages) {
    const route = routeOfFile(dist, file);
    const html = readFileSync(file, "utf8");
    const visible = visibleMarkup(html);
    const h1 = (visible.match(/<h1[\s>]/g) ?? []).length;
    if (h1 !== 1) err(route, `${h1} <h1> elements (one is required)`);
    if (!/<title>[^<]+<\/title>/.test(html)) err(route, "no <title>");
    if (route !== "/404.html" && !/<meta[^>]*name="description"[^>]*content="[^"]+"/.test(html))
      warn(route, "no meta description");
    const stray = strayExpression(html);
    if (stray) err(route, `shows an unevaluated template expression: ${stray.slice(0, 60)}`);
    // A callout whose type is not one of the five stays a blockquote with its marker showing.
    const marker = /\[!([A-Za-z]+)\]/.exec(visible.replaceAll(/<(pre|code)\b[\s\S]*?<\/\1>/gi, ""));
    if (marker)
      err(
        route,
        `shows the callout marker ${marker[0]} as text: the types are NOTE, TIP, IMPORTANT, WARNING and CAUTION`,
      );
    const seen = new Set<string>();
    for (const m of visible.matchAll(/\sid=("([^"]*)"|'([^']*)')/g)) {
      const id = decodeEntities(m[2] ?? m[3] ?? "");
      if (seen.has(id)) warn(route, `duplicate id "${id}"`);
      seen.add(id);
    }
    for (const ref of referencesOf(html)) {
      const target = resolveReference(route, ref.value);
      if (!target) continue;
      report.checked++;
      if (/\.md$/i.test(target.path)) {
        err(
          route,
          `${ref.attribute}="${ref.value}" points at a Markdown file; Jx rewrites links only to published pages`,
        );
        continue;
      }
      const found = fileFor(dist, target.path);
      if (!found) {
        err(route, `${ref.attribute}="${ref.value}" does not exist`);
        continue;
      }
      if (!found.exact)
        warn(
          route,
          `${ref.attribute}="${ref.value}" is missing its trailing slash (the host redirects it)`,
        );
      if (target.hash && found.file.endsWith(".html") && !idsFor(found.file).has(target.hash)) {
        err(
          route,
          `${ref.attribute}="${ref.value}": the page has no element with id "${target.hash}"`,
        );
      }
    }
  }

  const index = join(dist, "search-index.json");
  if (existsSync(index)) {
    try {
      const documents =
        (JSON.parse(readFileSync(index, "utf8")) as { documents?: Array<{ url?: string }> })
          .documents ?? [];
      const bad = new Set<string>();
      for (const doc of documents) {
        if (typeof doc.url !== "string") continue;
        report.checked++;
        const target = resolveReference("/", doc.url);
        const found = target ? fileFor(dist, target.path) : null;
        if (!target || !found || (target.hash && !idsFor(found.file).has(target.hash)))
          bad.add(doc.url);
      }
      for (const url of [...bad].slice(0, 20))
        err("/search-index.json", `result address ${url} is not a page or heading`);
      if (bad.size > 20)
        err(
          "/search-index.json",
          `${bad.size - 20} more result addresses are not pages or headings`,
        );
    } catch {
      err("/search-index.json", "is not valid JSON");
    }
  }

  if (options.nav) {
    for (const url of navUrls(options.nav)) {
      report.checked++;
      if (!fileFor(dist, url)?.exact)
        err(
          "(sidebar)",
          `the sidebar links to ${url}, which was not built (the address docusystem computed for the page is not the one Jx published)`,
        );
    }
    for (const file of pages) {
      const route = routeOfFile(dist, file);
      if (route.startsWith("/docs/") && !Object.hasOwn(options.nav.pages, route))
        err(
          route,
          "was built but is not in the sidebar data (the address docusystem computed for the page is not the one Jx published)",
        );
    }
    if (!existsSync(join(dist, "docs", "index.html")))
      err(
        "/docs/",
        "the documentation home was not built: docs/README.md is missing or unpublished",
      );
  }
  return report;
}

/** The issues of a crawl, one per line. */
export function formatIssues(issues: LinkIssue[]): string {
  return issues.map((i) => `  ${i.page}  ${i.message}`).join("\n");
}
