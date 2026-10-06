// The site assets built by the real, pinned Jx (section 9.1 "site", acceptance of WP7): a root is put
// together from site/ and the fixtures of test/site/fixtures (documentation, navigation, catalog), the
// released Jx compiler builds it, and what comes out is read as a browser, a search engine and a
// screen reader would: `Done: N routes` with N as expected, and a header, a sidebar and callouts that
// are already in the HTML. The assembling is `support/root.ts`, a stand-in for WP2's `assemble`.
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { NavData } from "../../src/lib/types.js";
import { REPO_ROOT } from "../support/index.js";
import { SAMPLE_CATALOG } from "./support/catalog.js";
import { DOC_FIXTURES, DOC_ROUTES, FIXTURE_CONFIG, NAV_FIXTURE } from "./support/fixtures.js";
import {
  assembleRoot,
  distOf,
  filesUnder,
  jxVersions,
  readDist,
  runJx,
  type JxRun,
} from "./support/root.js";
import { COMPONENTS, JX_PACKAGES, PAGES, PROJECT, readJson } from "./support/site.js";

/** A line of Jx output that docusystem's strict mode treats as a problem (section 5.1, step 10). */
const PROBLEM = /^(?:Content\b|Warning:|Error)/;

interface Built {
  root: string;
  run: JxRun;
  /** `/`-separated paths of every file of dist/. */
  files: string[];
  /** The text of every .html file of dist/, by path. */
  pages: Record<string, string>;
}

const work = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "docusystem-site-")));
afterAll(() => rmSync(work, { recursive: true, force: true }));

function build(name: string, options: Parameters<typeof assembleRoot>[1] = {}): Built {
  const root = assembleRoot(join(work, name), options);
  const run = runJx(root);
  const files = filesUnder(distOf(root));
  const pages = Object.fromEntries(
    files.filter((f) => f.endsWith(".html")).map((f) => [f, readDist(root, f)]),
  );
  return { root, run, files, pages };
}

let main: Built;
let other: Built;

beforeAll(() => {
  // The documentation fixture, strict like CI (`links: "error"`), with a `node_modules` folder in the
  // staged documentation that must not be published.
  main = build("main", {
    extraDocs: { "node_modules/pkg/README.md": "---\ntitle: Vendored\n---\n\nNot a page.\n" },
  });
  // Another project: its own name, domain, branch and docs folder, a lenient build.
  other = build("other", {
    strict: false,
    config: {
      name: "Other Project",
      slug: "other",
      domain: "other.avunu.net",
      repo: "https://github.com/Avunu/other",
      branch: "trunk",
      docsPath: "documentation/user",
      platform: "odoo",
      license: "Apache-2.0",
    },
  });
}, 120_000);

const nav = JSON.parse(readFileSync(NAV_FIXTURE, "utf8")) as NavData;

// ── helpers to read the HTML ────────────────────────────────────────────────────────────────────
/** The page without its stylesheets and scripts, which carry words that are not content. */
const content = (html: string): string =>
  html.replace(/<style>[\s\S]*?<\/style>/g, "").replace(/<script[\s\S]*?<\/script>/g, "");
const decode = (text: string): string =>
  text
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
const count = (html: string, pattern: RegExp): number => (html.match(pattern) ?? []).length;
/** The `data-jx-props` of the first element with this tag, parsed. */
function propsOf(html: string, tag: string): any {
  const match = new RegExp(`<${tag}\\b[^>]*data-jx-props="([^"]*)"`).exec(html);
  expect(match, `<${tag}> has no data-jx-props`).not.toBeNull();
  return JSON.parse(decode(match![1]!));
}
const pageOf = (built: Built, route: string): string => {
  const html = built.pages[`${route.slice(1)}index.html`];
  expect(html, `no page for ${route}`).toBeDefined();
  return html!;
};

describe("the build", () => {
  test("runs the released Jx the package pins, exactly", () => {
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    const pins = Object.fromEntries(
      Object.entries(manifest.dependencies).filter(([name]) => name.startsWith("@jxsuite/")),
    );
    expect(Object.keys(pins).sort()).toEqual([...JX_PACKAGES].sort());
    expect(jxVersions()).toEqual(pins);
  });

  test("succeeds in strict mode (links: error) and prints no line of a document problem", () => {
    expect(main.run.status, main.run.output).toBe(0);
    expect(main.run.output.split("\n").filter((line) => PROBLEM.test(line))).toEqual([]);
    expect(other.run.status, other.run.output).toBe(0);
    expect(other.run.output.split("\n").filter((line) => PROBLEM.test(line))).toEqual([]);
  });

  test("reports `Done: N routes` with N the number of pages of the nav plus the two static pages", () => {
    const staticPages = PAGES.filter((file) => !file.includes("[")).length;
    expect(staticPages).toBe(2); // pages/index.json and pages/404.json
    expect(Object.keys(nav.pages)).toHaveLength(DOC_ROUTES.length);
    expect(main.run.routes).toBe(Object.keys(nav.pages).length + staticPages);
    expect(main.run.routes).toBe(12);
  });

  test("publishes the routes of the docs content type, and only those", () => {
    const published = Object.keys(main.pages)
      .filter((file) => file.startsWith("docs/"))
      .map((file) => `/${file.replace(/index\.html$/, "")}`)
      .sort();
    expect(published).toEqual(DOC_ROUTES);
    expect(Object.keys(main.pages).sort()).toEqual(
      [
        "404/index.html",
        "index.html",
        ...DOC_ROUTES.map((route) => `${route.slice(1)}index.html`),
      ].sort(),
    );
  });

  test("leaves out underscore and dot paths, node_modules, drafts and pages with publish: false", () => {
    expect(DOC_FIXTURES.filter((f) => f.route === undefined)).toHaveLength(5);
    // Nothing is written under docs/ but the published routes (a page and its Markdown copy)...
    const written = new Set(
      main.files.filter((f) => f.startsWith("docs/")).map((f) => `/${f.replace(/[^/]+$/, "")}`),
    );
    expect([...written].sort()).toEqual(DOC_ROUTES);
    // ...and no word of a left-out file reaches the search index.
    const index = readDist(main.root, "search-index.json");
    for (const word of ["Private", "Vendored", "Draft", "Unpublished", "Not a page", "footer.md"]) {
      expect(index, word).not.toContain(word);
    }
    // Every published page is in the search index; nothing else is.
    const documents = JSON.parse(index).documents as Array<{ url: string }>;
    const urls = new Set(documents.map((d) => d.url.split("#")[0]));
    expect([...urls].sort()).toEqual(DOC_ROUTES);
  });

  test("names the three index spellings (README.md, readme.md, index.md) as the page of their folder", () => {
    for (const route of ["/docs/", "/docs/guides/", "/docs/faq/", "/docs/reference/advanced/"]) {
      expect(main.pages[`${route.slice(1)}index.html`], route).toBeDefined();
    }
    // A file name with capitals and a space becomes a slug.
    expect(main.pages["docs/guides/configuration-options/index.html"]).toBeDefined();
  });

  test("emits every component as components/<tag>.js (and its stylesheet) and leaves no custom element empty", () => {
    for (const file of COMPONENTS) {
      const tag = String(readJson(file).tagName);
      expect(main.files, tag).toContain(`components/${tag}.js`);
    }
    for (const [page, html] of Object.entries(main.pages)) {
      for (const file of COMPONENTS) {
        const tag = String(readJson(file).tagName);
        expect(html, `${page}: <${tag}> is empty`).not.toMatch(
          new RegExp(`<${tag}\\b[^>]*>\\s*</${tag}>`),
        );
      }
    }
  });

  test("evaluates every compiler-timed value: no template text is left in any page", () => {
    for (const [page, html] of Object.entries(main.pages)) {
      expect(content(html), page).not.toContain("${"); // includes `${state`: a value that was not computed
    }
  });

  test("a page has exactly one h1: the documents, the landing page and the 404 page", () => {
    for (const [page, html] of Object.entries(main.pages)) {
      expect(count(content(html), /<h1[\s>]/g), page).toBe(1);
    }
    // getting-started.md has one `# Getting started` that says the title: it is that h1, with its anchor.
    expect(pageOf(main, "/docs/getting-started/")).toContain(
      '<h1 id="getting-started">Getting started</h1>',
    );
    // README.md has none: the h1 is written from the title. guides/install.md has two: one is demoted.
    expect(pageOf(main, "/docs/")).toContain("Example Project documentation</h1>");
    expect(content(pageOf(main, "/docs/guides/install/"))).toContain(
      '<h2 id="a-second-top-level-heading">A second top-level heading</h2>',
    );
  });
});

describe("the header, already in the HTML", () => {
  test("names the project and links to avunu.net and the project's home", () => {
    for (const route of ["/", "/docs/", "/docs/guides/install/", "/404/"]) {
      const html = pageOf(main, route);
      expect(html, route).toContain('<a class="name" href="/">Example Project</a>');
      expect(html, route).toContain('aria-label="Avunu, go to avunu.net"');
      expect(html, route).toContain('<a class="skip-link" href="#main">Skip to content</a>');
    }
    expect(pageOf(other, "/")).toContain('<a class="name" href="/">Other Project</a>');
  });

  test("holds the search, the theme toggle and the project switcher, rendered from the catalog", () => {
    const html = pageOf(main, "/docs/");
    expect(html).toContain("<docs-search");
    expect(html).toContain("<theme-toggle");
    const switcher = propsOf(html, "project-switcher") as {
      current: string;
      groups: Array<{ platform: string; label: string; items: Array<Record<string, unknown>> }>;
    };
    expect(switcher.current).toBe("example");
    expect(switcher.groups.map((g) => g.platform)).toEqual(["frappe", "odoo", "nixos", "general"]);
    expect(switcher.groups.map((g) => g.label)).toEqual([
      "Frappe & ERPNext",
      "Odoo",
      "NixOS",
      "General",
    ]);
    const items = switcher.groups.flatMap((g) => g.items);
    expect(items.map((i) => i.slug).sort()).toEqual(
      SAMPLE_CATALOG.projects.map((p) => p.slug).sort(),
    );
    expect(items.filter((i) => i.current)).toEqual([
      expect.objectContaining({ slug: "example", caption: "You are here" }),
    ]);
    expect(items.find((i) => i.slug === "alpha")).toMatchObject({
      href: "https://alpha.avunu.net",
      caption: "Docs",
    });
    expect(items.find((i) => i.slug === "beta")).toMatchObject({
      href: "https://avunu.net/open-source/beta/",
      caption: "avunu.net",
    });
    // The project that is not in the catalog marks nobody as current.
    const unknown = propsOf(pageOf(other, "/"), "project-switcher") as {
      groups: Array<{ items: Array<{ current: boolean }> }>;
    };
    expect(unknown.groups.flatMap((g) => g.items).filter((i) => i.current)).toEqual([]);
  });

  test("the search is told the documentation's quick links", () => {
    const search = propsOf(pageOf(main, "/docs/"), "docs-search") as {
      links: Array<{ href: string }>;
    };
    expect(search.links.map((l) => l.href)).toEqual([
      "/docs/",
      "/docs/guides/",
      "/docs/faq/",
      "/docs/reference/api/",
    ]);
  });
});

describe("the sidebar and the drawer, already in the HTML", () => {
  const links = (html: string, tag: string): Array<{ href: string; current: string }> =>
    [
      ...(new RegExp(`<${tag}\\b[\\s\\S]*?</${tag}>`, "g").exec(html)?.[0] ?? "").matchAll(
        /<a href="([^"]+)" aria-current="(page|false)"/g,
      ),
    ].map((m) => ({ href: m[1]!, current: m[2]! }));

  test("lists every page of the nav once, in reading order of the sections, with a group for a folder", () => {
    const html = pageOf(main, "/docs/guides/install/");
    const sidebar = links(html, "docs-sidebar");
    expect(sidebar.map((l) => l.href).sort()).toEqual(DOC_ROUTES);
    expect(html).toContain('<nav aria-label="Documentation">');
    expect(html).toContain("<summary>Guides</summary>");
    expect(html).toContain("<summary>Questions</summary>");
    expect(html).toContain('<details class="group" open><summary>Advanced</summary>');
    // The label of a folder's README is "Overview"; a nav_title is used as it is.
    expect(html).toContain(">Programming interface</a>");
  });

  test("marks the current page, and only that one, in the page and in the drawer", () => {
    for (const route of DOC_ROUTES) {
      const html = pageOf(main, route);
      const sidebars = [...html.matchAll(/<docs-sidebar\b[\s\S]*?<\/docs-sidebar>/g)].map(
        (m) => m[0],
      );
      expect(sidebars, route).toHaveLength(2); // the one beside the page and the one in the drawer
      for (const sidebar of sidebars) {
        const current = links(sidebar, "docs-sidebar").filter((l) => l.current === "page");
        expect(current, route).toEqual([{ href: route, current: "page" }]);
      }
    }
  });

  test("opens every section when the site is small (the nav says expandAll)", () => {
    expect(nav.expandAll).toBe(true);
    const html = pageOf(main, "/docs/");
    expect(count(html, /<details class="section" open>/g)).toBe(2 * nav.sections.length);
  });

  test("has a drawer that is a popover with a close button, for narrow screens", () => {
    const html = pageOf(main, "/docs/");
    expect(html).toContain('<div id="docs-drawer" class="drawer" popover="auto" role="dialog"');
    expect(html).toContain('popovertarget="docs-drawer"');
    expect(html).toContain('class="drawer-close"');
  });

  test("the landing page has no sidebar", () => {
    expect(pageOf(main, "/")).not.toContain("<docs-sidebar");
  });
});

describe("the page, already in the HTML", () => {
  test("renders GitHub alerts as callouts of the five kinds, and no alert marker is left", () => {
    const kinds = new Set<string>();
    for (const route of DOC_ROUTES) {
      const html = content(pageOf(main, route));
      for (const m of html.matchAll(/<docs-callout data-alert="(\w+)"/g)) kinds.add(m[1]!);
      expect(html, route).not.toMatch(/\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/);
    }
    expect([...kinds].sort()).toEqual(["caution", "important", "note", "tip", "warning"]);
    const tip = content(pageOf(main, "/docs/getting-started/"));
    expect(tip).toMatch(
      /<docs-callout data-alert="tip"[^>]*>[\s\S]*?<div class="body" role="note">/,
    );
    expect(tip).toContain("that introduces them.</p></div></docs-callout>");
  });

  test("highlights code, keeps tables, and builds the table of contents from the headings", () => {
    const html = content(pageOf(main, "/docs/getting-started/"));
    expect(html).toContain('<code class="language-bash shiki">');
    expect(html).toContain("<table><thead>");
    expect(html).toContain('<a href="#requirements" class="d2">Requirements</a>');
    expect(html).toContain('<a href="#troubleshooting" class="d2">Troubleshooting</a>');
    expect(html).toContain('<a class="top-link" href="#main">Back to top');
  });

  test("shows the date and the tags of a page that has them, and hides the empty rows of one that has none", () => {
    const html = content(pageOf(main, "/docs/getting-started/"));
    expect(html).toContain('<time datetime="2026-10-01">2026-10-01</time>');
    expect(html).toContain("<li>install</li>");
    expect(html).toContain("<li>quick-start</li>");
    expect(content(pageOf(main, "/docs/guides/install/"))).toContain('<div class="meta" hidden>');
  });

  test("links the previous and next page from the nav", () => {
    const html = content(pageOf(main, "/docs/guides/install/"));
    expect(html).toContain('<a class="prev" href="/docs/guides/">');
    expect(html).toContain('<a class="next" href="/docs/guides/configuration-options/">');
    // The first page has no previous and the last has no next: the link is there, hidden and empty.
    const first = pageOf(main, nav.flat[0]!.url);
    const last = pageOf(main, nav.flat.at(-1)!.url);
    expect(first).toContain('<a class="prev" href="" hidden>');
    expect(first).toContain(`<a class="next" href="${nav.flat[1]!.url}">`);
    expect(last).toContain('<a class="next" href="" hidden>');
    expect(last).toContain(`<a class="prev" href="${nav.flat.at(-2)!.url}">`);
  });

  test("resolves links between pages, with a space in a file name and an anchor, to page URLs", () => {
    const html = content(pageOf(main, "/docs/getting-started/"));
    expect(html).toContain('href="/docs/guides/configuration-options/#options"');
    expect(content(pageOf(main, "/docs/"))).toContain('href="/docs/guides/install/"');
  });

  test("links Edit this page to the configured repository, branch and docs folder (the docsPath change)", () => {
    expect(pageOf(main, "/docs/guides/install/")).toContain(
      'href="https://github.com/Avunu/example/edit/main/docs/guides/install.md"',
    );
    expect(pageOf(main, "/docs/guides/configuration-options/")).toContain(
      'href="https://github.com/Avunu/example/edit/main/docs/guides/Configuration%20Options.md"',
    );
    // A project whose Markdown is not in docs/, on another branch, gets links that reach the files.
    expect(pageOf(other, "/docs/guides/install/")).toContain(
      'href="https://github.com/Avunu/other/edit/trunk/documentation/user/guides/install.md"',
    );
    expect(pageOf(other, "/docs/")).not.toContain("/edit/trunk/docs/");
  });

  test("sets the title, the description and the social tags from the document and the project", () => {
    const html = pageOf(main, "/docs/getting-started/");
    expect(html).toContain("<title>Getting started · Example Project</title>");
    expect(html).toContain(
      '<meta name="description" content="Install the example project and run it for the first time.">',
    );
    expect(html).toContain(
      '<meta property="og:title" content="Getting started · Example Project">',
    );
    expect(html).toContain('<meta content="Example Project" property="og:site_name">');
    expect(pageOf(main, "/docs/")).toContain(
      "<title>Example Project documentation · Example Project</title>",
    );
    expect(html).toContain('<html lang="en">');
  });
});

describe("the landing page and the 404 page", () => {
  test("the landing page names the project, says what it is and offers the documentation and the repository", () => {
    const html = content(pageOf(main, "/"));
    expect(html).toContain('<h1 id="home-title">Example Project</h1>');
    expect(html).toContain(`<p class="lede">${FIXTURE_CONFIG.tagline}</p>`);
    expect(html).toContain('<a class="btn primary" href="/docs/">Read the documentation');
    expect(html).toContain('<a class="btn secondary" href="https://github.com/Avunu/example">');
    expect(html).toContain("<li><b>License </b>");
    expect(html).toContain("<span>MIT</span>");
    expect(html).toContain("<span>General</span>");
    expect(pageOf(other, "/")).toContain("<span>Apache-2.0</span>");
    expect(pageOf(other, "/")).toContain("<span>Odoo</span>");
    expect(pageOf(other, "/")).toContain("Open source · Odoo");
  });

  test("the landing page shows the first pages of the nav as cards", () => {
    const html = content(pageOf(main, "/"));
    const cards = [...html.matchAll(/<a class="card" href="([^"]+)">/g)].map((m) => m[1]);
    expect(cards).toEqual(nav.featured.map((f) => f.url));
    expect(nav.featured.length).toBeGreaterThan(0);
  });

  test("the 404 page says so and offers a way back", () => {
    const html = content(pageOf(main, "/404/"));
    expect(html).toContain("<h1>Page not found</h1>");
    expect(html).toContain('<a class="btn" href="/docs/">Browse the documentation</a>');
    expect(html).toContain('<a class="btn secondary" href="/">Example Project home</a>');
  });

  test("every page has the footer with the project's license and the Avunu mark", () => {
    for (const [page, html] of Object.entries(main.pages)) {
      expect(html, page).toContain("<docs-footer");
      expect(content(html), page).toContain("Example Project is released under the MIT license.");
      expect(html, page).toContain('src="/brand/avunu-logo-light.svg"');
    }
  });
});

describe("the files Jx publishes next to the pages", () => {
  test("copies public/: fonts with their licenses, marks, favicons, .nojekyll and the CNAME it was given", () => {
    for (const file of [
      ".nojekyll",
      "CNAME",
      "favicon.svg",
      "favicon.ico",
      "brand/avunu-icon.svg",
      "brand/avunu-logo-light.svg",
      "fonts/LICENSE-Figtree.txt",
      "fonts/LICENSE-JetBrainsMono.txt",
    ]) {
      expect(main.files, file).toContain(file);
    }
    expect(main.files.filter((f) => /^fonts\/.*\.woff2$/.test(f))).toHaveLength(6);
    expect(readDist(main.root, "CNAME")).toBe("example.avunu.net\n");
    expect(readDist(other.root, "CNAME")).toBe("other.avunu.net\n");
  });

  test("writes the sitemap, robots.txt and the search index for the project's domain", () => {
    expect(readDist(main.root, "robots.txt")).toContain(
      "Sitemap: https://example.avunu.net/sitemap.xml",
    );
    expect(readDist(main.root, "sitemap.xml")).toContain(
      "<loc>https://example.avunu.net/docs/getting-started</loc>",
    );
    expect(readDist(other.root, "sitemap.xml")).toContain("https://other.avunu.net/");
    expect(JSON.parse(readDist(main.root, "search-index.json")).version).toBe(1);
  });

  test("every font a stylesheet names is in the output, and every font in the output is named", () => {
    const html = pageOf(main, "/");
    const named = new Set(
      [...html.matchAll(/url\("\/(fonts\/[\w-]+\.woff2)"\)/g)].map((m) => m[1]!),
    );
    expect(named.size).toBe(6);
    const published = main.files.filter((f) => /^fonts\/.*\.woff2$/.test(f));
    expect([...named].sort()).toEqual(published.sort());
    expect(html).toContain(
      '<link rel="preload" href="/fonts/figtree-latin-wght-normal.woff2" as="font"',
    );
    // No page names a font host or any other third-party origin for a resource it loads.
    for (const [page, text] of Object.entries(main.pages)) {
      const loaded = [...text.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)]
        .map((m) => new URL(m[1]!).hostname)
        .filter((host) => !["avunu.net", "github.com", "example.avunu.net"].includes(host));
      expect(loaded, page).toEqual([]);
      expect(text, page).not.toMatch(/fonts\.(?:googleapis|gstatic)\.com/);
    }
  });
});

describe("light and dark", () => {
  test("every page carries the tokens of both themes, and the stored choice is applied before first paint", () => {
    const html = pageOf(main, "/docs/");
    expect(html).toContain(`:root { --color-bg: ${PROJECT.style["--color-bg"]};`);
    expect(html).toContain("prefers-color-scheme: dark");
    expect(html).toContain("data-color-scheme");
    expect(html).toContain('localStorage.getItem("jx-color-scheme")');
    expect(html).toContain(
      '<meta name="theme-color" content="#120F19" media="(prefers-color-scheme: dark)">',
    );
    // The scheme script runs in <head>, before the body, so there is no flash.
    expect(html.indexOf("jx-color-scheme")).toBeLessThan(html.indexOf("<body"));
  });

  test("the theme toggle is a component that is loaded on every page", () => {
    for (const [page, html] of Object.entries(main.pages)) {
      expect(html, page).toContain(
        '<script type="module" src="/components/theme-toggle.js"></script>',
      );
    }
  });
});

describe("a title that holds markup", () => {
  // Jx escapes every text node and attribute it writes except the text of <title>, which it writes
  // as it is: a title with `</title>` in it ended the element and put what followed into the head.
  // The titles of pages come from front matter and from headings (a code span or an entity in a
  // heading is plain text in the title), so both are tried; the sidebar data carries the title the
  // page shows, as it does in a real build.
  const PAYLOAD = '</title><script>document.documentElement.setAttribute("data-pwn","1")</script>';
  const TITLES: Record<string, string> = {
    "/docs/evil-front-matter/": `Evil ${PAYLOAD}`,
    "/docs/evil-heading/": `Code ${PAYLOAD} span`,
  };
  let hostile: Built;

  beforeAll(() => {
    const navPages = { ...nav.pages };
    for (const [route, title] of Object.entries(TITLES)) {
      navPages[route] = { title, description: "", section: "", prev: null, next: null, edit: "" };
    }
    hostile = build("hostile", {
      nav: { ...nav, pages: navPages },
      extraDocs: {
        "evil-front-matter.md": `---\ntitle: '${TITLES["/docs/evil-front-matter/"]!.replaceAll("'", "''")}'\n---\n\nBody.\n`,
        "evil-heading.md": `# Code \`${PAYLOAD}\` span\n\nBody.\n`,
      },
    });
  }, 120_000);

  test("is built without a problem", () => {
    expect(hostile.run.status, hostile.run.output).toBe(0);
    expect(hostile.run.output.split("\n").filter((line) => PROBLEM.test(line))).toEqual([]);
  });

  test("is text in <title>: one element, nothing after it, the page's own title around it", () => {
    for (const route of Object.keys(TITLES)) {
      const html = pageOf(hostile, route);
      const head = html.slice(0, html.lastIndexOf("</head>"));
      expect(count(head, /<title>/g), route).toBe(1);
      expect(count(head, /<\/title>/g), route).toBe(1);
      const text = /<title>([\s\S]*?)<\/title>/.exec(head)![1]!;
      expect(text, route).not.toMatch(/[<>]/);
      expect(decode(text), route).toBe(`${TITLES[route]} · Example Project`);
      // no script came out of it, in the head or anywhere else on the page
      expect(html, route).not.toContain(`<script>document.documentElement.setAttribute("data-pwn"`);
    }
  });

  test("is text in the social tags and in the page's h1 as well", () => {
    for (const route of Object.keys(TITLES)) {
      const html = pageOf(hostile, route);
      const og = /<meta property="og:title" content="([^"]*)">/.exec(html)![1]!;
      expect(decode(og), route).toBe(`${TITLES[route]} · Example Project`);
      expect(og, route).not.toContain("<");
      expect(content(html), route).not.toContain("</title><script>");
    }
  });

  test("leaves the other pages as they were", () => {
    for (const route of DOC_ROUTES) {
      expect(pageOf(hostile, route), route).toBe(pageOf(main, route));
    }
  });
});
