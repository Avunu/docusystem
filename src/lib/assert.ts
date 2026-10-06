// Step 12 of the pipeline (section 5.1): positive assertions on the built site.
//
// Jx ignores what it does not understand and still exits 0: a component that was not registered is
// written to the page as an empty custom element and the build "succeeds" with the page missing its
// header; a raw HTML anchor comes out as an empty link; an unevaluated template expression is shown
// as text. So the build is checked after the fact, from the files it wrote, and every check says
// what it found. A failed assertion is fatal in every mode (invariant 10): the pipeline prints each
// one as `ok`/`FAIL` (formatAssertion) and publishes nothing when one fails.
//
// The assertions read only `dist` (and the component files of the project root, to know which custom
// elements are registered); they prove the output, not the code that made it.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  decodeEntities,
  distFiles,
  fileFor,
  htmlPages,
  referencesOf,
  resolveReference,
  routeOfFile,
  strayExpression,
  visibleMarkup,
} from "./links.js";
import type { Assertion } from "./types.js";

const pass = (message: string): Assertion => ({ ok: true, message });
const fail = (message: string): Assertion => ({ ok: false, message });
const verdict = (ok: boolean, good: string, bad: string): Assertion =>
  ok ? pass(good) : fail(bad);

/** `a, b, c and 4 more`: a bounded list for a message. */
function listOf(items: string[], max = 5): string {
  if (items.length <= max) return items.join(", ");
  return `${items.slice(0, max).join(", ")} and ${items.length - max} more`;
}

const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** One line as it is printed: `ok   <message>` or `FAIL <message>`. */
export function formatAssertion(assertion: Assertion): string {
  return `${assertion.ok ? "ok  " : "FAIL"} ${assertion.message}`;
}

// ---- What the project root registers ----

export interface ComponentFile {
  /** The file name inside components/, `docs-footer.json`. */
  file: string;
  /** The custom element tag; Jx names the emitted module after it. */
  tag: string;
}

/**
 * The components of a project root: every `components/*.json` (flat: Jx registers nothing deeper),
 * with the tag it defines, and the files that could not be read as a component.
 */
export function componentsOf(root: string): { components: ComponentFile[]; unreadable: string[] } {
  const dir = join(root, "components");
  const components: ComponentFile[] = [];
  const unreadable: string[] = [];
  if (!existsSync(dir)) return { components, unreadable };
  const names = distFiles(dir).filter((file) => !file.includes("/") && file.endsWith(".json"));
  for (const file of names) {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, file), "utf8")) as { tagName?: unknown };
      const tag =
        typeof parsed.tagName === "string" ? parsed.tagName : file.slice(0, -".json".length);
      components.push({ file, tag });
    } catch {
      unreadable.push(`components/${file}`);
    }
  }
  return { components, unreadable };
}

const escapeRegExp = (text: string): string => text.replaceAll(/[\\^$.*+?()[\]{}|]/g, "\\$&");

/** The text of a tag's attributes: anything up to `>`, with quoted values that may themselves hold a `>`. */
const ATTRIBUTE_TEXT = `(?:[^>"']|"[^"]*"|'[^']*')*`;
/** The attributes of a tag, or nothing: they start with white space. */
const ATTRIBUTES = `(?:\\s${ATTRIBUTE_TEXT})?`;

/** The tags of registered components that stand in `html` with nothing inside them: the pre-render did not happen. */
export function emptyComponents(html: string, tags: string[]): string[] {
  if (tags.length === 0) return [];
  const empty = new RegExp(
    `<(${tags.map(escapeRegExp).join("|")})${ATTRIBUTES}>\\s*</\\1\\s*>`,
    "gi",
  );
  const found = new Set<string>();
  for (const m of visibleMarkup(html).matchAll(empty)) found.add(m[1]!.toLowerCase());
  return [...found].sort();
}

/** The elements whose presence inside a link gives it something to read or show. */
const MEDIA = /<(?:img|svg|picture|video|canvas|object|iframe|embed)\b/i;
const NAMED_BY_ATTRIBUTE =
  /\s(?:aria-label|aria-labelledby|title)\s*=\s*(?:"[^"]*\S[^"]*"|'[^']*\S[^']*')/i;

/**
 * The links of a page that have no text, no image and no `aria-label` (or `aria-labelledby`/`title`):
 * for a screen reader and for a reader with images off there is nothing to follow. Jx writes a raw
 * HTML anchor as `<a href></a>text`, which is the usual cause. Returns the opening tag of each.
 */
export function emptyLinks(html: string): string[] {
  const found: string[] = [];
  const anchor = new RegExp(`<a(?=\\s|>)(${ATTRIBUTE_TEXT})>([\\s\\S]*?)</a\\s*>`, "gi");
  for (const m of visibleMarkup(html).matchAll(anchor)) {
    const attributes = m[1] ?? "";
    if (!/(?:^|\s)href(?=\s|=|$)/i.test(attributes)) continue; // a target, not a link
    if (NAMED_BY_ATTRIBUTE.test(` ${attributes}`) || MEDIA.test(m[2]!)) continue;
    const text = decodeEntities(m[2]!.replaceAll(/<[^>]*>/g, "")).replaceAll(
      /[\s\u00a0\u200b]+/g,
      "",
    );
    if (text === "") found.push(`<a${attributes}>`);
  }
  return found;
}

/**
 * Whether the head of a page holds more than one `<title>` or `</title>`. Jx writes the text of the
 * title as it is, so a title that carries `</title>` ends the element early and what follows it is
 * live HTML in the head (a `<script>` from a front-matter title, say). The text is the one thing that
 * cannot be trusted to delimit itself, so this counts the tags instead of reading the text between
 * them. The head ends at the last `</head>`: the Markdown of a page cannot write one (Jx escapes the
 * text of the body), so it is Jx's own, even when the title has forged one earlier.
 */
export function titleHoldsMarkup(html: string): boolean {
  const end = html.toLowerCase().lastIndexOf("</head");
  const head = end === -1 ? html : html.slice(0, end);
  return (
    (head.match(/<title[\s/>]/gi)?.length ?? 0) > 1 ||
    (head.match(/<\/title[\s/>]/gi)?.length ?? 0) > 1
  );
}

// ---- Fonts ----

/** Hosts of font services: a documentation site publishes its own fonts (the reader's address goes nowhere else). */
const FONT_HOSTS =
  /(?:^|\.)(?:fonts\.googleapis\.com|fonts\.gstatic\.com|use\.typekit\.net|p\.typekit\.net|fonts\.bunny\.net|fast\.fonts\.net|cloud\.typography\.com|use\.fontawesome\.com|kit\.fontawesome\.com|fonts\.adobe\.com)$/i;

interface Stylesheet {
  /** The address it is served at: the page for inline styles, the file for a .css file. */
  route: string;
  css: string;
}

/** Every inline `<style>` of the pages and every `.css` file of the site. */
function stylesheetsOf(dist: string, pages: Array<{ route: string; html: string }>): Stylesheet[] {
  const sheets: Stylesheet[] = [];
  for (const { route, html } of pages) {
    for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi))
      sheets.push({ route, css: m[1]! });
  }
  for (const file of distFiles(dist)) {
    if (file.endsWith(".css")) {
      sheets.push({ route: `/${file}`, css: readFileSync(join(dist, ...file.split("/")), "utf8") });
    }
  }
  return sheets;
}

/** The URLs written in `url(...)` and `@import` in a piece of CSS. */
function urlsInCss(css: string): string[] {
  const urls: string[] = [];
  for (const m of css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s'"]*))\s*\)/gi))
    urls.push((m[1] ?? m[2] ?? m[3] ?? "").trim());
  for (const m of css.matchAll(/@import\s+(?:"([^"]*)"|'([^']*)')/gi))
    urls.push((m[1] ?? m[2])!.trim());
  return urls;
}

const isExternal = (url: string): boolean => /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(url);

function hostOf(url: string): string | null {
  try {
    return new URL(url, "https://local.invalid/").hostname;
  } catch {
    return null;
  }
}

// ---- The assertions ----

/**
 * Step 12. `root` is the assembled project root (its `components/` say which custom elements are
 * registered), `dist` the post-processed Jx output, `expected.cname` the configured domain and
 * `expected.routes` the number of pages the build must have produced (the sidebar's pages plus the
 * static ones; `null` leaves the count unchecked). `expected.sources` says which Markdown file each
 * page was built from (route to the file as the repository shows it, `docs/guide/x.md`), so that a
 * failure about a page can name the file the author has to open. Returns one assertion per fact, all
 * of them even after a failure, in the order the record lists them.
 */
export function assertBuild(
  root: string,
  dist: string,
  expected: { cname: string; routes: number | null; sources?: Record<string, string> },
): Assertion[] {
  if (!existsSync(dist)) return [fail(`${dist} does not exist: the build produced nothing`)];
  const out: Assertion[] = [];
  const files = new Set(distFiles(dist));
  const pages = htmlPages(dist).map((file) => ({
    route: routeOfFile(dist, file),
    html: readFileSync(file, "utf8"),
  }));
  const read = (rel: string): string => readFileSync(join(dist, ...rel.split("/")), "utf8");

  // Every component of the root was compiled to a module named after its tag.
  const { components, unreadable } = componentsOf(root);
  const missing = [...new Set(components.map((c) => c.tag))].filter(
    (tag) => !files.has(`components/${tag}.js`),
  );
  if (components.length === 0 && unreadable.length === 0) {
    out.push(
      fail(
        "the project root has no components (components/*.json): nothing to render the pages with",
      ),
    );
  } else if (missing.length === 0 && unreadable.length === 0) {
    out.push(pass(`${plural(components.length, "component")} emitted as components/<tag>.js`));
  } else {
    out.push(
      fail(
        [
          missing.length > 0 ? `not emitted as components/<tag>.js: ${listOf(missing)}` : "",
          unreadable.length > 0 ? `not valid JSON: ${listOf(unreadable)}` : "",
        ]
          .filter((part) => part !== "")
          .join("; "),
      ),
    );
  }

  // No registered custom element was left empty (Jx exits 0 and writes `<tag></tag>`).
  const tags = [...new Set(components.map((c) => c.tag).filter((tag) => tag.includes("-")))];
  const hollow = pages.flatMap(({ route, html }) => {
    const found = emptyComponents(html, tags);
    return found.length > 0 ? [`${route} (${found.join(", ")})`] : [];
  });
  out.push(
    verdict(
      hollow.length === 0,
      "no page has an empty, un-rendered component",
      `empty components, not rendered: ${listOf(hollow)}`,
    ),
  );

  // No link with nothing to read (Jx writes a raw HTML anchor as `<a href></a>text`). The page is
  // named with the Markdown file it was built from when that is known: the rendered HTML has no
  // line, but lint reports the raw anchor for that file with one.
  const hollowLinks = pages.flatMap(({ route, html }) => {
    const found = emptyLinks(html);
    const source = expected.sources?.[route];
    return found.length > 0
      ? [
          `${route}${source === undefined ? "" : ` from ${source}`} ` +
            `(${found[0]}${found.length > 1 ? ` and ${found.length - 1} more` : ""})`,
        ]
      : [];
  });
  out.push(
    verdict(
      hollowLinks.length === 0,
      "no page has a link without text, image or aria-label",
      `links with nothing inside: ${listOf(hollowLinks)}. A raw HTML <a href> in that page's Markdown ` +
        "is the usual cause (Jx leaves the link empty and puts its text after it): `docusystem lint` lists it " +
        "with its file and line, and [text](url) replaces it",
    ),
  );

  // Exactly one <h1> per page.
  const headings = pages.flatMap(({ route, html }) => {
    const count = (visibleMarkup(html).match(/<h1[\s>]/g) ?? []).length;
    return count === 1 ? [] : [`${route} (${count})`];
  });
  out.push(
    verdict(
      headings.length === 0,
      "every page has exactly one <h1>",
      `pages without exactly one <h1>: ${listOf(headings)}`,
    ),
  );

  // The text of <title> is text: Jx writes it unescaped, so a `</title>` in it would end the element.
  const injected = pages.flatMap(({ route, html }) => (titleHoldsMarkup(html) ? [route] : []));
  out.push(
    verdict(
      injected.length === 0,
      "every page's <title> is text only, with no markup after it",
      `the <title> ends early, so what follows it in the head is live markup (a title that holds </title>): ${listOf(injected)}`,
    ),
  );

  // No template expression shown as text.
  const stray = pages.flatMap(({ route, html }) => {
    const found = strayExpression(html);
    return found === null ? [] : [`${route} (${found.slice(0, 40)})`];
  });
  out.push(
    verdict(
      stray.length === 0,
      "no unevaluated ${state text on any page",
      `unevaluated template expressions shown as text: ${listOf(stray)}`,
    ),
  );

  // CNAME.
  const cname = files.has("CNAME") ? read("CNAME").trim() : "";
  out.push(
    verdict(
      cname === expected.cname,
      `CNAME says ${expected.cname}`,
      `CNAME is ${cname === "" ? "missing" : cname}, it must say ${expected.cname}`,
    ),
  );

  // Fonts: self-hosted, referenced locally, from no font service.
  const fonts = [...files].filter((file) => /^fonts\/.+\.woff2$/i.test(file));
  out.push(
    verdict(
      fonts.length > 0,
      `${plural(fonts.length, "self-hosted font file")} in fonts/`,
      "no fonts/*.woff2 in the site",
    ),
  );
  const sheets = stylesheetsOf(dist, pages);
  const faces = new Map<string, string>(); // resolved path or raw URL -> problem ("" when none)
  for (const { route, css } of sheets) {
    for (const rule of css.matchAll(/@font-face\s*\{[^}]*\}/gi)) {
      for (const url of urlsInCss(rule[0])) {
        if (url.startsWith("data:")) continue;
        if (isExternal(url)) {
          faces.set(url, `${url} is not local`);
          continue;
        }
        const target = resolveReference(route, url);
        const path = target?.path ?? url;
        if (!faces.has(path))
          faces.set(
            path,
            target !== null && fileFor(dist, target.path) ? "" : `${url} is not in the site`,
          );
      }
    }
  }
  const faceProblems = [...faces.values()].filter((problem) => problem !== "");
  out.push(
    verdict(
      faces.size > 0 && faceProblems.length === 0,
      `${plural(faces.size, "@font-face URL")}, all local and present in the site`,
      faces.size === 0
        ? "no @font-face rule points at a font file"
        : `@font-face URLs that are not local files: ${listOf(faceProblems)}`,
    ),
  );
  const services = new Set<string>();
  const references = [
    ...pages.flatMap(({ html }) =>
      referencesOf(html)
        .filter((r) => r.tag === "link")
        .map((r) => r.value),
    ),
    ...sheets.flatMap(({ css }) => urlsInCss(css)),
  ];
  for (const url of references) {
    const host = isExternal(url) ? hostOf(url) : null;
    if (host !== null && FONT_HOSTS.test(host)) services.add(host);
  }
  out.push(
    verdict(
      services.size === 0,
      "no third-party font host is referenced",
      `a third-party font host is referenced: ${[...services].sort().join(", ")}`,
    ),
  );

  // Favicons and .nojekyll.
  const lacking = ["favicon.svg", "favicon.ico"].filter((file) => !files.has(file));
  out.push(
    verdict(
      lacking.length === 0,
      "favicon.svg and favicon.ico are published",
      `missing: ${lacking.join(", ")}`,
    ),
  );
  out.push(
    verdict(
      files.has(".nojekyll"),
      ".nojekyll is published",
      ".nojekyll is missing (GitHub Pages would run Jekyll over the site)",
    ),
  );

  // The search index has an entry for every documentation page.
  out.push(
    searchCoverage(files.has("search-index.json") ? read("search-index.json") : null, pages),
  );

  // The sitemap is on the configured domain.
  out.push(sitemapOnDomain(files.has("sitemap.xml") ? read("sitemap.xml") : null, expected.cname));

  // 404.html is published and the folder Jx wrote it to is gone.
  const notFoundFolder = [...files].some((file) => file.startsWith("404/"));
  out.push(
    verdict(
      files.has("404.html") && !notFoundFolder,
      "404.html is published and there is no /404/ folder",
      files.has("404.html")
        ? "a /404/ folder is published (the page must be 404.html only)"
        : "404.html is missing",
    ),
  );

  // No Markdown copies of pages.
  const copies = [...files].filter(
    (file) =>
      (file === "index.md" || file.endsWith("/index.md")) &&
      files.has(`${file.slice(0, -"index.md".length)}index.html`),
  );
  out.push(
    verdict(
      copies.length === 0,
      "no Markdown copies of pages (index.md beside index.html)",
      `Markdown copies of pages are published: ${listOf(copies)}`,
    ),
  );

  // The project switcher was pre-rendered from the catalog.
  out.push(switcherPrerendered(pages.find((p) => p.route === "/")?.html ?? null));

  // The route count.
  if (expected.routes !== null) {
    out.push(
      verdict(
        pages.length >= expected.routes,
        `${plural(pages.length, "page")} built (${expected.routes} expected)`,
        `${plural(pages.length, "page")} built, ${expected.routes} expected: Jx dropped ${plural(expected.routes - pages.length, "route")}`,
      ),
    );
  }
  return out;
}

function searchCoverage(raw: string | null, pages: Array<{ route: string }>): Assertion {
  if (raw === null) return fail("search-index.json is missing");
  let documents: Array<{ url?: unknown }>;
  try {
    const parsed = JSON.parse(raw) as { documents?: unknown };
    if (!Array.isArray(parsed.documents)) return fail('search-index.json has no "documents" list');
    documents = parsed.documents as Array<{ url?: unknown }>;
  } catch {
    return fail("search-index.json is not valid JSON");
  }
  const indexed = new Set<string>();
  for (const doc of documents) if (typeof doc.url === "string") indexed.add(doc.url.split("#")[0]!);
  const docs = pages.map((p) => p.route).filter((route) => route.startsWith("/docs/"));
  const absent = docs.filter((route) => !indexed.has(route));
  return verdict(
    absent.length === 0,
    `search-index.json has an entry for each of the ${plural(docs.length, "documentation page")}`,
    `search-index.json has no entry for: ${listOf(absent)}`,
  );
}

function sitemapOnDomain(raw: string | null, domain: string): Assertion {
  if (raw === null) return fail("sitemap.xml is missing");
  const locations = [...raw.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) =>
    decodeEntities(m[1]!.trim()),
  );
  if (locations.length === 0) return fail("sitemap.xml lists no page");
  const prefix = `https://${domain}/`;
  const problems: string[] = [];
  for (const loc of locations) {
    if (!loc.startsWith(prefix)) problems.push(`${loc} is not on ${domain}`);
    else if ([`${prefix}404`, `${prefix}404/`, `${prefix}404.html`].includes(loc))
      problems.push(`${loc} is the 404 page`);
    else if (!loc.endsWith("/") && !loc.endsWith(".html"))
      problems.push(`${loc} lacks the trailing slash`);
  }
  return verdict(
    problems.length === 0,
    `sitemap.xml lists ${plural(locations.length, "page")} on ${domain}`,
    `sitemap.xml: ${listOf(problems)}`,
  );
}

function switcherPrerendered(landing: string | null): Assertion {
  if (landing === null)
    return fail("the landing page (index.html) is missing: no project switcher to look at");
  const element = /<project-switcher\b((?:[^>"']|"[^"]*"|'[^']*')*)>/i.exec(landing);
  if (!element) return fail("the landing page has no <project-switcher>");
  const props = /\sdata-jx-props=(?:"([^"]*)"|'([^']*)')/i.exec(element[1]!);
  if (!props) return fail("the project switcher has no data-jx-props: it was not pre-rendered");
  let groups: Array<{ items?: unknown[] }>;
  try {
    const parsed = JSON.parse(decodeEntities(props[1] ?? props[2] ?? "")) as { groups?: unknown };
    if (!Array.isArray(parsed.groups)) return fail("the project switcher's data has no groups");
    groups = parsed.groups as Array<{ items?: unknown[] }>;
  } catch {
    return fail("the project switcher's data is not valid JSON");
  }
  const projects = groups.reduce((n, g) => n + (Array.isArray(g.items) ? g.items.length : 0), 0);
  return verdict(
    projects > 0,
    `the project switcher is pre-rendered from the catalog (${plural(projects, "project")} in ${plural(groups.length, "group")})`,
    "the project switcher was pre-rendered with no project in it (the catalog was empty or not read)",
  );
}
