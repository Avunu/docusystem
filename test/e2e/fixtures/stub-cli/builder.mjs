// A built site, written by hand, for testing the scripts that read one (assert-dist, compare-dist) and the
// ones that drive a build (test-pack). It has everything scripts/assert-dist.mjs requires; `breaks` names
// what to take away or spoil, one failing assertion each. It is not what the package produces: the real
// output is checked by running the packed package (scripts/test-pack.mjs).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const COMPONENTS = [
  "docs-callout",
  "docs-enhance",
  "docs-footer",
  "docs-header",
  "docs-icon",
  "docs-pager",
  "docs-prose",
  "docs-search",
  "docs-sidebar",
  "docs-toc",
  "project-switcher",
  "theme-toggle",
];
export const FONTS = [
  "figtree-latin-ext-wght-normal",
  "figtree-latin-wght-italic",
  "figtree-latin-wght-normal",
  "jetbrains-mono-latin-400-normal",
  "jetbrains-mono-latin-500-normal",
  "jetbrains-mono-latin-ext-400-normal",
];

export const SITE = {
  name: "Example Site",
  tagline: "A sample site that shows what the documentation system builds from Markdown.",
  domain: "example.avunu.net",
};

/** Two documentation pages, the second with two callouts. */
export const PAGES = [
  { route: "/docs/", title: "Documentation · Example Site", h1: "Home", callouts: 1 },
  { route: "/docs/guide/", title: "Guide · Example Site", h1: "Guide", callouts: 2 },
];

const write = (dir, file, text) => {
  const path = join(dir, ...file.split("/"));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

const props = (groups) => JSON.stringify({ current: "example", groups }).replaceAll('"', "&quot;");

/**
 * Writes a site into `dir`.
 *
 * @param {string} dir
 * @param {{ site?: typeof SITE, pages?: typeof PAGES, hrefs?: string[], srcs?: string[], breaks?: string[], extraFiles?: Record<string, string> }} [o]
 */
export function buildDist(dir, o = {}) {
  const site = o.site ?? SITE;
  const pages = o.pages ?? PAGES;
  const breaks = new Set(o.breaks ?? []);
  const has = (name) => breaks.has(name);

  const nav = pages.map((p) => `<li><a href="${p.route}" aria-current="false">${p.h1}</a></li>`).join("");
  const links = (o.hrefs ?? []).map((url) => `<li><a href="${url}">${url}</a></li>`).join("");
  const images = (o.srcs ?? []).map((url) => `<img alt="An image" src="${url}">`).join("");
  const sidebar = (route) =>
    has("no-sidebar") && route !== "/"
      ? ""
      : `<docs-sidebar data-jx-static><nav aria-label="Documentation"><ul>${has("sidebar-missing-page") ? nav.split("</li>")[0] + "</li>" : nav}</ul></nav></docs-sidebar>`;
  const switcher = has("switcher-empty")
    ? `<project-switcher data-jx-props="${props([])}"><button class="trigger">Projects</button></project-switcher>`
    : `<project-switcher data-jx-props="${props([{ platform: "general", label: "General", items: [{ slug: "example", title: "Example", href: "https://avunu.net/open-source/example/" }] }])}"><button class="trigger">Projects</button></project-switcher>`;
  const emptyElement = has("empty-element") ? "<docs-footer></docs-footer>" : "";
  const fontUrl = has("font-host") ? "https://fonts.gstatic.com/s/figtree.woff2" : "/fonts/figtree-latin-wght-normal.woff2";
  const fontFace = has("font-face-remote")
    ? `@font-face{font-family:Figtree;src:url(https://cdn.example.net/figtree.woff2)}`
    : `@font-face{font-family:Figtree;src:url(${fontUrl})}`;
  const dark = has("no-dark") ? "" : "@media (prefers-color-scheme: dark){:root{--bg:#120f19}}";
  const toggle = has("no-toggle") ? "" : '<theme-toggle data-jx-static><button aria-label="Switch colour scheme">Theme</button></theme-toggle>';
  const search = has("no-search-ui") ? "" : '<docs-search data-jx-static><button>Search</button></docs-search>';

  const page = ({ route, title, h1, callouts = 0 }, isLanding = false) => {
    const canonical = `https://${has("wrong-canonical") ? "elsewhere.example.net" : site.domain}${route}`;
    const ogUrl = has("og-missing") ? "" : `<meta content="${canonical}" property="og:url">`;
    const alerts = Array.from({ length: callouts }, (_, i) => {
      const type = has("callout-type") ? "danger" : ["note", "tip", "important", "warning", "caution"][i % 5];
      return `<docs-callout data-alert="${type}" data-jx-static><p>Callout ${i + 1}</p></docs-callout>`;
    }).join("");
    const body = isLanding
      ? `<h1>${site.name}</h1><p>${has("landing-no-name") ? "" : site.tagline}</p>`
      : `<h1>${h1}</h1>${has("two-h1") ? "<h1>Again</h1>" : ""}${alerts}<p>Text.</p>${links ? `<ul>${links}</ul>` : ""}${images}`;
    const link = (href, text) => `<a href="${href}">${text}</a>`;
    const extras = [
      has("empty-link") ? '<a href="/docs/"></a>' : "",
      has("empty-href") ? '<a href="">Nowhere</a>' : "",
      has("hidden-link") ? '<a class="next" href="" hidden><span></span></a>' : "",
      has("md-link") ? link("guide.md", "A Markdown file") : "",
      has("broken-link") ? link("/docs/missing/", "A missing page") : "",
      has("broken-asset") ? '<img alt="Gone" src="/images/gone.png">' : "",
      has("img-no-src") ? '<img alt="No source">' : "",
      has("template-expr") ? "<p>${state.title}</p>" : "",
      emptyElement,
    ].join("");
    return (
      `<!DOCTYPE html><html lang="en"><head><meta charset="utf8">` +
      `<title>${has("title-expr") ? "${state.title}" : title}</title>` +
      `${has("no-canonical") ? "" : `<link href="${canonical}" rel="canonical">`}${ogUrl}` +
      `<style>${fontFace}${dark}</style><link rel="modulepreload" href="/components/docs-enhance.js"></head>` +
      `<body><a class="skip-link" href="#main">Skip to content</a>` +
      `<docs-header data-jx-static><header><a class="name" href="/">${site.name}</a>${switcher}${toggle}${search}</header></docs-header>` +
      `<main id="main">${sidebar(route)}<article>${body}${extras}</article></main>` +
      `<docs-footer data-jx-static><footer><p>Footer</p></footer></docs-footer>` +
      `<script type="module" src="/components/docs-enhance.js"></script></body></html>`
    );
  };

  // pages
  write(dir, "index.html", page({ route: "/", title: `${site.name}: documentation`, h1: site.name }, true));
  write(dir, has("404-folder") ? "404/index.html" : "404.html", page({ route: "/404", title: `Page not found · ${site.name}`, h1: "Not found" }));
  for (const p of pages) {
    write(dir, `${p.route.slice(1)}index.html`, page(p));
  }
  if (has("extra-page")) write(dir, "docs/extra/index.html", page({ route: "/docs/extra/", title: "Extra · Example Site", h1: "Extra" }));
  if (has("md-copy")) write(dir, "docs/guide/index.md", "# Guide\n");

  // what GitHub Pages needs
  if (!has("no-cname")) write(dir, "CNAME", `${has("wrong-cname") ? "elsewhere.example.net" : site.domain}\n`);
  if (!has("no-nojekyll")) write(dir, ".nojekyll", "");
  write(dir, "favicon.svg", "<svg xmlns='http://www.w3.org/2000/svg'/>");
  if (!has("no-favicon-ico")) write(dir, "favicon.ico", "ico");
  write(dir, "brand/avunu-icon.svg", "<svg xmlns='http://www.w3.org/2000/svg'/>");
  for (const font of has("few-fonts") ? FONTS.slice(0, 3) : FONTS) write(dir, `fonts/${font}.woff2`, "font");
  for (const tag of COMPONENTS) {
    const code = tag === "project-switcher" && !has("no-catalog-url") ? 'fetch("https://avunu.net/projects.json")' : "export {}";
    write(dir, `components/${tag}.js`, code);
  }

  // sitemap and search
  const routes = ["/", ...pages.map((p) => p.route), ...(has("extra-page") ? ["/docs/extra/"] : [])];
  const locs = routes
    .filter((r) => !(has("sitemap-missing-page") && r === "/docs/guide/"))
    .map((r) => {
      const trailing = has("sitemap-no-slash") && r === "/docs/guide/" ? r.slice(0, -1) : r;
      return `  <url>\n    <loc>https://${site.domain}${trailing}</loc>\n  </url>`;
    });
  if (has("sitemap-404")) locs.push(`  <url>\n    <loc>https://${site.domain}/404/</loc>\n  </url>`);
  write(dir, "sitemap.xml", `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${locs.join("\n")}\n</urlset>\n`);
  if (!has("no-search-index")) {
    const docs = pages.filter((p) => !(has("search-missing-page") && p.route === "/docs/guide/")).map((p) => ({ url: p.route, title: p.h1 }));
    write(dir, "search-index.json", JSON.stringify({ documents: docs }));
  }
  for (const [file, text] of Object.entries(o.extraFiles ?? {})) write(dir, file, text);
  return dir;
}

/** The config file of the site that `buildDist` writes. */
export function configOf(site = SITE) {
  return { ...site, slug: "example", platform: "general", repo: "https://github.com/Avunu/example", license: "MIT" };
}
