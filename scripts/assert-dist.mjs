#!/usr/bin/env node
// Asserts that a built site has everything a docusystem site must have. It reads only the built folder
// and the shell's `docusystem.config.json`, never the implementation, so it is an independent witness of
// the output: `docusystem check` asserts the same things from the inside, this proves them from the
// outside. scripts/test-pack.mjs runs it against an example installed from the packed tarball.
//
//   node scripts/assert-dist.mjs <dist> <docusystem.config.json> [options]
//
//   --pages <n>             The number of documentation pages (the `docs/**/index.html` files) must be n.
//   --alerts <n>            The number of GitHub alerts that became callouts must be n (default: at least one).
//   --href <url>            Some page must link to exactly this address. Repeatable.
//   --src <url>             Some page must load an image or other resource from exactly this address.
//   --title <route>=<text>  The <title> of the page at <route> (for example /docs/guide/install/) must be
//                           exactly <text>. Repeatable.
//   --json                  Print the results as JSON on standard output (the human lines go to stderr).
//
// Exit codes: 0 every assertion passed; 1 an assertion failed; 2 usage error or an unreadable input.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

/** Hosts a self-hosted site must not load fonts from. */
const FONT_HOSTS =
  /fonts\.googleapis\.com|fonts\.gstatic\.com|fonts\.bunny\.net|use\.typekit\.net|use\.fontawesome\.com/;

const USAGE =
  "usage: node scripts/assert-dist.mjs <dist> <docusystem.config.json> [--pages n] [--alerts n]\n" +
  "         [--href url]... [--src url]... [--title route=text]... [--json]";

function usage(message) {
  if (message) console.error(`assert-dist: ${message}`);
  console.error(USAGE);
  return 2;
}

/** The text of `html` with the blocks that are not content removed. */
const visible = (html) => html.replace(/<(script|style|template)\b[\s\S]*?<\/\1>/g, "");

/** `html` with the bodies of scripts and styles emptied, so that their tags (and `src`) stay readable. */
const tagsOnly = (html) => html.replace(/<(script|style)\b([^>]*)>[\s\S]*?<\/\1>/g, "<$1$2></$1>");

const decode = (text) =>
  text
    .replaceAll("&quot;", '"')
    .replaceAll("&#34;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");

/** Every `/`-separated file below `dir`, relative to it, sorted. */
function walk(dir, prefix = "") {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? walk(join(dir, entry.name), `${prefix}${entry.name}/`)
        : [`${prefix}${entry.name}`],
    )
    .sort();
}

/** The values of an attribute (`href`, `src`) of every tag in `html`; `srcset` is split into its URLs. */
function references(html) {
  const out = [];
  for (const m of html.matchAll(/\s(href|src|srcset)="([^"]*)"/g)) {
    const value = decode(m[2]);
    if (m[1] === "srcset") {
      for (const candidate of value.split(",")) {
        const url = candidate.trim().split(/\s+/)[0];
        if (url) out.push({ attribute: "srcset", url });
      }
    } else out.push({ attribute: m[1], url: value });
  }
  return out;
}

/** The file of `dist` that answers an internal address the way GitHub Pages does, or null. */
function resolveInternal(dist, url) {
  const path = decodeURIComponent(url.split(/[?#]/)[0]);
  const candidates = path.endsWith("/")
    ? [`${path}index.html`]
    : /\.[a-z0-9]+$/i.test(path)
      ? [path]
      : [`${path}/index.html`, `${path}.html`];
  for (const candidate of candidates) {
    const file = join(dist, ...candidate.split("/").filter(Boolean));
    if (existsSync(file) && statSync(file).isFile()) return candidate;
  }
  return null;
}

/** The route of an `index.html` page: `docs/guide/install/index.html` is `/docs/guide/install/`. */
const routeOf = (file) => `/${file.replace(/index\.html$/, "")}`;

function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        pages: { type: "string" },
        alerts: { type: "string" },
        href: { type: "string", multiple: true },
        src: { type: "string", multiple: true },
        title: { type: "string", multiple: true },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    return usage(error.message);
  }
  const { values, positionals } = parsed;
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  if (positionals.length !== 2) return usage("expected a dist folder and a config file");
  const count = (name) => {
    if (values[name] === undefined) return undefined;
    if (!/^\d+$/.test(values[name])) throw new Error(`--${name} must be a whole number`);
    return Number(values[name]);
  };
  let expectedPages;
  let expectedAlerts;
  try {
    expectedPages = count("pages");
    expectedAlerts = count("alerts");
  } catch (error) {
    return usage(error.message);
  }
  const titles = [];
  for (const spec of values.title ?? []) {
    const at = spec.indexOf("=");
    if (at < 1) return usage(`--title wants <route>=<text>, got ${spec}`);
    titles.push([spec.slice(0, at), spec.slice(at + 1)]);
  }

  const dist = resolve(positionals[0]);
  if (!existsSync(dist) || !statSync(dist).isDirectory()) return usage(`${dist} is not a folder`);
  let config;
  try {
    config = JSON.parse(readFileSync(resolve(positionals[1]), "utf8"));
  } catch (error) {
    return usage(`cannot read the config file: ${error.message}`);
  }
  for (const key of ["name", "tagline", "domain"]) {
    if (typeof config[key] !== "string" || config[key] === "") {
      return usage(`the config file has no "${key}"`);
    }
  }

  const results = [];
  const out = values.json ? console.error : console.log;
  const check = (name, ok, detail = "") => {
    results.push({ name, ok, detail });
    out(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
  };
  /** A check over a list of offenders: passes when the list is empty and names the first few otherwise. */
  const none = (name, offenders) =>
    check(
      name,
      offenders.length === 0,
      offenders.length === 0
        ? ""
        : `${offenders.length}: ${offenders.slice(0, 5).join("; ")}${offenders.length > 5 ? "; ..." : ""}`,
    );

  const all = walk(dist);
  const read = (rel) => readFileSync(join(dist, ...rel.split("/")), "utf8");
  const has = (rel) => existsSync(join(dist, ...rel.split("/")));
  const html = all.filter((f) => f.endsWith(".html"));
  const pages = html.filter((f) => f.startsWith("docs/"));
  const index = has("index.html") ? read("index.html") : "";
  const domain = config.domain;

  // ---- what GitHub Pages needs ----
  check("CNAME says the configured domain", has("CNAME") && read("CNAME").trim() === domain);
  check(".nojekyll is published", has(".nojekyll"));
  check(
    "404.html is published (and no /404/ folder)",
    has("404.html") && !all.some((f) => f.startsWith("404/")),
  );
  none(
    "no Markdown copies in the site",
    all.filter((f) => f.endsWith(".md")),
  );

  // ---- fonts, icons, themes ----
  const fonts = all.filter((f) => f.startsWith("fonts/") && f.endsWith(".woff2"));
  check("self-hosted fonts are published", fonts.length >= 6, `${fonts.length} woff2`);
  check(
    "favicons and brand marks",
    ["favicon.svg", "favicon.ico", "brand/avunu-icon.svg"].every(has),
  );
  const fontFaces = [...index.matchAll(/@font-face\s*\{[^}]*\}/g)].map((m) => m[0]);
  check(
    "@font-face points at /fonts/",
    fontFaces.length > 0 &&
      fontFaces.every((rule) =>
        [...rule.matchAll(/url\(([^)]*)\)/g)].every((u) => /["']?\/fonts\//.test(u[1])),
      ),
    `${fontFaces.length} rule(s)`,
  );
  none(
    "no third-party font host in any page or stylesheet",
    all.filter((f) => /\.(?:html|css|js)$/.test(f) && FONT_HOSTS.test(read(f))),
  );
  check(
    "light and dark themes (prefers-color-scheme and the toggle)",
    /prefers-color-scheme: ?dark/.test(index) && /<theme-toggle\b/.test(index),
  );

  // ---- the landing page and the documentation pages ----
  check(
    "landing page names the project",
    index.includes(config.name) && index.includes(config.tagline.slice(0, 30)),
  );
  if (expectedPages !== undefined) {
    check(
      `${expectedPages} documentation pages`,
      pages.length === expectedPages,
      `${pages.length}`,
    );
  }
  none(
    "every page has exactly one h1",
    html.filter((f) => (visible(read(f)).match(/<h1[\s>]/g) ?? []).length !== 1),
  );
  none(
    "every page has a non-empty <title> without a template expression",
    html.filter((f) => {
      const title = read(f).match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "";
      return title.trim() === "" || title.includes("${");
    }),
  );
  none(
    "no template expression left unevaluated",
    html.filter((f) => /\$\{state\./.test(visible(read(f)))),
  );
  const callouts = html.reduce(
    (n, f) => n + (visible(read(f)).match(/<docs-callout\b[^>]*\bdata-alert="/g) ?? []).length,
    0,
  );
  if (expectedAlerts !== undefined) {
    check(
      `${expectedAlerts} GitHub alerts became callouts`,
      callouts === expectedAlerts,
      `${callouts}`,
    );
  } else check("GitHub alerts became callouts", callouts > 0, `${callouts}`);
  none(
    "every callout has a known type",
    html.flatMap((f) =>
      [...visible(read(f)).matchAll(/<docs-callout\b[^>]*\bdata-alert="([^"]*)"/g)]
        .filter((m) => !["note", "tip", "important", "warning", "caution"].includes(m[1]))
        .map((m) => `${f}: ${m[1]}`),
    ),
  );

  // ---- registered components are rendered ----
  const components = all
    .filter((f) => /^components\/[^/]+\.js$/.test(f))
    .map((f) => f.slice("components/".length, -".js".length));
  check("components are published", components.length >= 12, `${components.length} component(s)`);
  none(
    "no registered custom element is left empty (un-rendered)",
    html.flatMap((f) => {
      const text = visible(read(f));
      return components
        .filter((tag) => new RegExp(`<${tag}\\b[^>]*>\\s*</${tag}>`).test(text))
        .map((tag) => `${f}: <${tag}>`);
    }),
  );

  // ---- links and resources ----
  none(
    "no link without an address or without text",
    html.flatMap((f) => {
      const text = visible(read(f));
      const bad = [];
      for (const m of text.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)) {
        const attributes = m[1];
        if (/\shidden(?:\s|=|$)/.test(attributes)) continue; // a placeholder, such as the pager's missing neighbour
        const href = attributes.match(/\shref(?:="([^"]*)")?/);
        if (!href || href[1] === undefined || href[1].trim() === "") {
          if (href) bad.push(`${f}: <a> with an empty href`);
          continue;
        }
        const named = /\saria-label(?:ledby)?="[^"]+"/.test(attributes);
        const inner = m[2].replace(/<[^>]*>/g, "").trim();
        if (inner === "" && !named && !/<img\b[^>]*\balt="[^"]+"/.test(m[2])) {
          bad.push(`${f}: <a href="${decode(href[1])}"> has no text`);
        }
      }
      return bad;
    }),
  );
  const refs = [];
  for (const f of html) {
    for (const r of references(tagsOnly(read(f)))) {
      refs.push({ attribute: r.attribute, url: r.url, page: f });
    }
  }
  none(
    "no link of the site itself ends in .md",
    refs
      .filter(
        (r) =>
          r.attribute === "href" &&
          !/^[a-z][a-z0-9+.-]*:/i.test(r.url) &&
          /\.md(?:[?#]|$)/.test(r.url),
      )
      .map((r) => `${r.page}: ${r.url}`),
  );
  none(
    "every internal link, image and script resolves to a published file",
    refs
      .filter((r) => r.url.startsWith("/") && !r.url.startsWith("//"))
      .filter((r) => resolveInternal(dist, r.url) === null)
      .map((r) => `${r.page}: ${r.url}`),
  );
  none(
    "every image of a page has a source",
    html.flatMap((f) =>
      [...visible(read(f)).matchAll(/<img\b([^>]*)>/g)]
        .filter((m) => !/\ssrc="[^"]+"/.test(m[1]))
        .map(() => `${f}: <img> without src`),
    ),
  );
  const missing = (wanted, attribute) =>
    wanted.filter(
      (url) =>
        !refs.some((r) => (attribute === "href") === (r.attribute === "href") && r.url === url),
    );
  if (values.href) {
    none(`every expected link is present (${values.href.length})`, missing(values.href, "href"));
  }
  if (values.src) {
    none(`every expected resource is loaded (${values.src.length})`, missing(values.src, "src"));
  }

  // ---- canonical addresses, sitemap, search ----
  none(
    "documentation pages have the canonical address and og:url on the configured domain",
    pages.flatMap((f) => {
      const text = read(f);
      const canonical = text.match(
        /<link\b[^>]*\brel="canonical"[^>]*\bhref="([^"]*)"|<link\b[^>]*\bhref="([^"]*)"[^>]*\brel="canonical"/,
      );
      const ogUrl = text.match(
        /<meta\b[^>]*\bproperty="og:url"[^>]*\bcontent="([^"]*)"|<meta\b[^>]*\bcontent="([^"]*)"[^>]*\bproperty="og:url"/,
      );
      const want = `https://${domain}${routeOf(f)}`;
      const got = canonical?.[1] ?? canonical?.[2];
      const og = ogUrl?.[1] ?? ogUrl?.[2];
      const bad = [];
      if (got !== want) bad.push(`${f}: canonical is ${got ?? "missing"}, wanted ${want}`);
      if (og !== want) bad.push(`${f}: og:url is ${og ?? "missing"}, wanted ${want}`);
      return bad;
    }),
  );
  const sitemap = has("sitemap.xml") ? read("sitemap.xml") : "";
  const locs = [...sitemap.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]);
  check(
    "sitemap uses the configured domain and trailing slashes",
    locs.length > 0 &&
      locs.every((loc) => loc.startsWith(`https://${domain}/`) && loc.endsWith("/")),
    `${locs.length} address(es)`,
  );
  none(
    "sitemap lists every page except 404",
    [...html.filter((f) => f !== "404.html").map((f) => `https://${domain}${routeOf(f)}`)].filter(
      (url) => !locs.includes(url),
    ),
  );
  none(
    "the sitemap does not list the 404 page",
    locs.filter((loc) => /\/404\/?$/.test(loc)),
  );
  const search = has("search-index.json") ? JSON.parse(read("search-index.json")) : null;
  check(
    "search index covers every documentation page",
    !!search &&
      Array.isArray(search.documents) &&
      pages.every((f) => search.documents.some((d) => d.url === routeOf(f))),
    search ? `${search.documents?.length} entries` : "missing",
  );
  check("search UI shipped", components.includes("docs-search") && /<docs-search\b/.test(index));

  // ---- navigation ----
  const sidebarPage = pages.find((f) => /<docs-sidebar\b/.test(read(f)));
  const sidebarLinks = sidebarPage
    ? new Set(
        [
          ...(read(sidebarPage).match(/<docs-sidebar[\s\S]*?<\/docs-sidebar>/)?.[0] ?? "").matchAll(
            /<a\b[^>]*\shref="([^"]*)"/g,
          ),
        ].map((m) => m[1]),
      )
    : new Set();
  none(
    "the sidebar of a documentation page lists every documentation page",
    sidebarPage
      ? pages.map(routeOf).filter((route) => !sidebarLinks.has(route))
      : ["no sidebar found"],
  );
  const switcher = index.match(/<project-switcher[^>]*data-jx-props="([^"]*)"/);
  let groups = [];
  if (switcher) {
    try {
      groups = JSON.parse(decode(switcher[1])).groups ?? [];
    } catch {
      groups = [];
    }
  }
  const entries = groups.reduce((n, g) => n + (g.items?.length ?? 0), 0);
  check(
    "project switcher is pre-rendered from the catalog",
    entries > 0,
    `${groups.length} platform group(s), ${entries} project(s)`,
  );
  check(
    "project switcher script (live catalog in the browser)",
    has("components/project-switcher.js") &&
      read("components/project-switcher.js").includes("https://avunu.net/projects.json"),
  );

  // ---- what the page says ----
  if (titles.length > 0) {
    none(
      `page titles are as expected (${titles.length})`,
      titles.flatMap(([route, wanted]) => {
        const file = route.endsWith("/") ? `${route.slice(1)}index.html` : route.slice(1);
        if (!has(file)) return [`${route}: no such page`];
        const title = decode(read(file).match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "");
        return title === wanted
          ? []
          : [`${route}: ${JSON.stringify(title)}, wanted ${JSON.stringify(wanted)}`];
      }),
    );
  }

  const failed = results.filter((r) => !r.ok);
  out(`\nassert-dist: ${results.length - failed.length}/${results.length} checks passed`);
  if (values.json) console.log(JSON.stringify({ passed: failed.length === 0, results }, null, 2));
  return failed.length === 0 ? 0 : 1;
}

process.exitCode = main(process.argv.slice(2));
