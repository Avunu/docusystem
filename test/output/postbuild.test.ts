import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { assertBuild } from "../../src/lib/assert.js";
import { checkLinks } from "../../src/lib/links.js";
import {
  dropMarkdownCopies,
  escapeTitle,
  fixCanonical,
  fixSearchIndex,
  githubUrl,
  isNoindex,
  repoTarget,
  rewriteRepoLinks,
  runPostbuild,
  sitemapXml,
  unhighlightedLanguages,
} from "../../src/lib/postbuild.js";
import { routeOfFile } from "../../src/lib/links.js";
import type { DocsConfig, NavData, PageInfo } from "../../src/lib/types.js";
import { listTree, readTree, tempDir, writeTree } from "../support/index.js";
import { OUTPUT_FIXTURES, copySite, drop, edit, put } from "./helpers.js";

const SITE = "https://frappe-nix.avunu.net";

const config = (
  o: Partial<DocsConfig> & { branch?: string } = {},
): DocsConfig & { branch: string } => ({
  name: "frappe-nix",
  tagline: "Reproducible Nix infrastructure for Frappe and ERPNext.",
  slug: "frappe-nix",
  platform: "nixos",
  repo: "https://github.com/Avunu/frappe-nix",
  domain: "frappe-nix.avunu.net",
  license: "MIT",
  branch: "main",
  ...o,
});

const info = (title: string, source: string, description = ""): PageInfo => ({
  title,
  description,
  section: "",
  prev: null,
  next: null,
  edit: source,
});

/** The parts of the sidebar data that postbuild reads. */
const navOf = (pages: Record<string, PageInfo>): NavData => ({
  home: { label: "Home", url: "/docs/" },
  loose: [],
  sections: [],
  expandAll: true,
  pages,
  flat: [],
  featured: [],
});

const page = (extra = "", url = "/docs/a"): string =>
  `<!DOCTYPE html><html><head><title>T</title><link href="${SITE}${url}" rel="canonical"><meta content="${SITE}${url}" property="og:url">${extra}</head><body><h1>x</h1><p>x\n</p></body></html>`;

const noRepo = (): { repoRoot: string; docsDir: string } => {
  const repoRoot = tempDir();
  return { repoRoot, docsDir: join(repoRoot, "docs") };
};

test("routes are the addresses files are served at", () => {
  const dist = "/x/dist";
  expect(routeOfFile(dist, "/x/dist/index.html")).toBe("/");
  expect(routeOfFile(dist, "/x/dist/docs/a/index.html")).toBe("/docs/a/");
  expect(routeOfFile(dist, "/x/dist/404.html")).toBe("/404.html");
  // Only a file named exactly index.html stands for its folder.
  expect(routeOfFile(dist, "/x/dist/docs/myindex.html")).toBe("/docs/myindex.html");
});

test("the canonical link and og:url get the trailing slash the page is served at", () => {
  const html = fixCanonical(page(), "/docs/a/", SITE);
  expect(html).toContain(`<link href="${SITE}/docs/a/" rel="canonical">`);
  expect(html).toContain(`<meta content="${SITE}/docs/a/" property="og:url">`);
});

test("a canonical that points at another site is left alone", () => {
  const html = '<link href="https://other.example/x" rel="canonical">';
  expect(fixCanonical(html, "/docs/a/", SITE)).toBe(html);
});

test("the sitemap lists addresses with their trailing slash and nothing else", () => {
  const xml = sitemapXml(SITE, ["/", "/docs/", "/docs/a b/"]);
  expect(xml).toContain("<loc>https://frappe-nix.avunu.net/</loc>");
  expect(xml).toContain("<loc>https://frappe-nix.avunu.net/docs/a%20b/</loc>");
  expect(xml).not.toContain("lastmod");
  expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
});

test("noindex pages are recognised", () => {
  expect(isNoindex('<meta name="robots" content="noindex, nofollow">')).toBe(true);
  expect(isNoindex('<meta name="robots" content="index, follow">')).toBe(false);
  expect(isNoindex("<p>nothing</p>")).toBe(false);
});

test("the search index gets the page's own title, section and heading rows alike", () => {
  const index = JSON.stringify({
    version: 1,
    documents: [
      { url: "/docs/", title: "README", description: "" },
      { url: "/docs/#requirements", title: "README", description: "" },
      { url: "/docs/guide/", title: "Fine", description: "kept" },
      { url: "/elsewhere/", title: "Other" },
    ],
  });
  const { text, changed } = fixSearchIndex(index, {
    "/docs/": { title: "frappe-nix", description: "Nix." },
    "/docs/guide/": { title: "Fine", description: "x" },
  });
  const docs = JSON.parse(text).documents;
  expect(changed).toBe(2);
  expect(docs.map((d: { title: string }) => d.title)).toEqual([
    "frappe-nix",
    "frappe-nix",
    "Fine",
    "Other",
  ]);
  expect(docs[0].description).toBe("Nix.");
  expect(docs[2].description).toBe("kept");
});

test("a search index in a shape it does not know is returned untouched", () => {
  expect(fixSearchIndex("not json", {})).toEqual({ text: "not json", changed: 0 });
  expect(fixSearchIndex('{"other":1}', {})).toEqual({ text: '{"other":1}', changed: 0 });
});

test("a search result whose address is a property name of Object is not a page", () => {
  const raw = JSON.stringify({
    documents: [
      { url: "__proto__", title: "x" },
      { url: "constructor", title: "y" },
    ],
  });
  expect(fixSearchIndex(raw, {})).toEqual({ text: raw.replaceAll(" ", ""), changed: 0 });
});

describe("runPostbuild", () => {
  test("tidies pages, rewrites the sitemap, publishes the 404 and fixes the search index", () => {
    const dist = writeTree(tempDir(), {
      "index.html": page("", "/"),
      "docs/a/index.html": page("<p>Run \n<code>x</code>\n.</p>"),
      "404/index.html":
        '<title>Not found</title><meta name="robots" content="noindex, nofollow"><h1>x</h1>',
      CNAME: "frappe-nix.avunu.net\n",
      "sitemap.xml": "<old/>",
      "search-index.json": JSON.stringify({ documents: [{ url: "/docs/a/", title: "a" }] }),
    });
    const summary = runPostbuild(
      dist,
      config(),
      navOf({ "/docs/a/": info("Page A", "a.md") }),
      noRepo(),
    );
    expect(summary).toMatchObject({
      pages: 3,
      sitemapUrls: 2,
      searchTitles: 1,
      notFound: true,
      cname: true,
      markdownCopies: 0,
      canonicals: 1,
      repoLinks: [],
      warnings: [],
    });
    expect(existsSync(join(dist, "404.html"))).toBe(true);
    expect(existsSync(join(dist, "404"))).toBe(false);
    expect(readFileSync(join(dist, "docs/a/index.html"), "utf8")).toContain(
      "<p>Run <code>x</code>.</p>",
    );
    const sitemap = readFileSync(join(dist, "sitemap.xml"), "utf8");
    expect(sitemap).toContain("/docs/a/</loc>");
    expect(sitemap).not.toContain("404");
    expect(
      JSON.parse(readFileSync(join(dist, "search-index.json"), "utf8")).documents[0].title,
    ).toBe("Page A");
  });

  test("the sitemap lists pages in the order of their files, as the starter's did, noindex pages left out", () => {
    const dist = writeTree(tempDir(), {
      "index.html": page("", "/"),
      "docs/index.html": page("", "/docs"),
      "docs/a/index.html": page("", "/docs/a"),
      "docs/a/b/index.html": page("", "/docs/a/b"),
      "docs/hidden/index.html": page('<meta name="robots" content="noindex">', "/docs/hidden"),
      "404.html": "<title>x</title>",
    });
    const summary = runPostbuild(dist, config(), navOf({}), noRepo());
    expect(summary.sitemapUrls).toBe(4);
    expect(
      [...readFileSync(join(dist, "sitemap.xml"), "utf8").matchAll(/<loc>([^<]*)</g)].map(
        (m) => m[1],
      ),
    ).toEqual([`${SITE}/docs/a/b/`, `${SITE}/docs/a/`, `${SITE}/docs/`, `${SITE}/`]);
  });

  test("the marker that staging wrote for a `${` is text again in the page body and stays in attribute values", () => {
    const marker = `$${String.fromCodePoint(0x200b)}{`;
    const dist = writeTree(tempDir(), {
      "index.html": page("", "/"),
      "docs/a/index.html": page(
        `<p>Set <code>${marker}HOME}</code> and <a href="https://e.org/${marker}x}">link</a>.</p>`,
      ),
    });
    runPostbuild(dist, config(), navOf({}), noRepo());
    const body = readFileSync(join(dist, "docs/a/index.html"), "utf8");
    expect(body).toContain("<code>&#36;{HOME}</code>");
    expect(body).toContain(`href="https://e.org/${marker}x}"`);
  });

  test("the title, the meta tags and the search index get the plain `${` back: nothing evaluates them", () => {
    const marker = `$${String.fromCodePoint(0x200b)}{`;
    const dist = writeTree(tempDir(), {
      "index.html": page("", "/"),
      "docs/a/index.html": `<!doctype html><html><head><title>Set ${marker}HOME} safely</title><meta name="description" content="Use ${marker}HOME}"></head><body><p>x</p></body></html>`,
      "search-index.json": JSON.stringify({
        documents: [
          {
            url: "/docs/a/",
            title: "a",
            text: `Use ${marker}HOME} and $ ${String.fromCodePoint(0x200b)}{PORT}`,
          },
        ],
      }),
    });
    runPostbuild(
      dist,
      config(),
      navOf({ "/docs/a/": info(`Set ${marker}HOME} safely`, "a.md") }),
      noRepo(),
    );
    const html = readFileSync(join(dist, "docs/a/index.html"), "utf8");
    expect(html).toContain("<title>Set ${HOME} safely</title>");
    expect(html).toContain('name="description" content="Use ${HOME}"');
    const index = JSON.parse(readFileSync(join(dist, "search-index.json"), "utf8"));
    expect(index.documents[0].title).toBe("Set ${HOME} safely");
    expect(index.documents[0].text).toBe("Use ${HOME} and $ {PORT}");
  });

  test("an existing 404.html is kept as it is and counts as published", () => {
    const dist = writeTree(tempDir(), {
      "index.html": page("", "/"),
      "404.html": "<title>x</title>",
    });
    expect(runPostbuild(dist, config(), navOf({}), noRepo()).notFound).toBe(true);
    const bare = writeTree(tempDir(), { "index.html": page("", "/") });
    expect(runPostbuild(bare, config(), navOf({}), noRepo()).notFound).toBe(false);
  });

  test("a CNAME that is not the domain is for the assertions to report, not an exception", () => {
    const dist = writeTree(tempDir(), {
      "index.html": page("", "/"),
      CNAME: "someone-else.avunu.net\n",
    });
    expect(runPostbuild(dist, config(), navOf({}), noRepo()).cname).toBe(true);
    expect(readFileSync(join(dist, "CNAME"), "utf8")).toBe("someone-else.avunu.net\n");
  });

  test("a missing dist is an error that says the build produced nothing", () => {
    expect(() => runPostbuild(join(tempDir(), "missing"), config(), navOf({}), noRepo())).toThrow(
      /does not exist: the build produced nothing/,
    );
  });

  test("reports unhighlighted languages as warnings, escapes the title and removes Markdown copies", () => {
    const dist = writeTree(tempDir(), {
      "docs/a/index.html": page('<pre><code class="language-rust">x</code></pre>').replace(
        "<title>T</title>",
        "<title>A<b></title>",
      ),
      "docs/a/index.md": "# copy",
    });
    const summary = runPostbuild(dist, config(), navOf({}), noRepo());
    expect(summary.warnings).toHaveLength(1);
    expect(summary.warnings[0]).toContain("/docs/a/");
    expect(summary.warnings[0]).toContain("rust");
    expect(summary.markdownCopies).toBe(1);
    expect(readFileSync(join(dist, "docs", "a", "index.html"), "utf8")).toContain(
      "<title>A&lt;b&gt;</title>",
    );
  });

  test("repository links are rewritten from the docs file that holds them, on the resolved branch", () => {
    const repo = writeTree(tempDir(), {
      LICENSE: "MIT",
      "lib/tool.nix": "x",
      "docs/README.md": "# Home\n",
    });
    const dist = join(repo, "docs-site", "dist");
    mkdirSync(join(dist, "docs"), { recursive: true });
    writeFileSync(
      join(dist, "docs", "index.html"),
      page(
        '<a href="lib/tool.nix">tool</a><a href="LICENSE#top">license</a><a href="missing.txt">gone</a>',
        "/docs",
      ),
    );
    const summary = runPostbuild(
      dist,
      config({ branch: "trunk" }),
      navOf({ "/docs/": info("Home", "README.md") }),
      { repoRoot: repo, docsDir: join(repo, "docs") },
    );
    expect(summary.repoLinks.map((l) => l.to)).toEqual([
      "https://github.com/Avunu/frappe-nix/blob/trunk/lib/tool.nix",
      "https://github.com/Avunu/frappe-nix/blob/trunk/LICENSE#top",
    ]);
    const html = readFileSync(join(dist, "docs", "index.html"), "utf8");
    expect(html).toContain('href="https://github.com/Avunu/frappe-nix/blob/trunk/lib/tool.nix"');
    expect(html).toContain('href="missing.txt"');
  });

  test("a page that is not in the sidebar data keeps its repository-relative links (the crawl reports them)", () => {
    const repo = writeTree(tempDir(), { LICENSE: "MIT" });
    const dist = join(repo, "docs-site", "dist");
    put(join(dist, "extra", "index.html"), page('<a href="LICENSE">license</a>', "/extra"));
    const summary = runPostbuild(dist, config(), navOf({}), {
      repoRoot: repo,
      docsDir: join(repo, "docs"),
    });
    expect(summary.repoLinks).toEqual([]);
    expect(readFileSync(join(dist, "extra", "index.html"), "utf8")).toContain('href="LICENSE"');
  });

  test("links are resolved from the folder of the Markdown file, not the folder of the page", () => {
    const repo = writeTree(tempDir(), { "docs/guides/example.json": "{}", "docs/README.md": "x" });
    const dist = join(repo, "docs-site", "dist");
    put(
      join(dist, "docs", "guides", "setup", "index.html"),
      page('<a href="example.json">file</a>', "/docs/guides/setup"),
    );
    const summary = runPostbuild(
      dist,
      config(),
      navOf({ "/docs/guides/setup/": info("Setup", "guides/setup.md") }),
      { repoRoot: repo, docsDir: join(repo, "docs") },
    );
    expect(summary.repoLinks.map((l) => l.to)).toEqual([
      "https://github.com/Avunu/frappe-nix/blob/main/docs/guides/example.json",
    ]);
  });

  test("a symbolic link in dist is neither followed nor rewritten nor removed", () => {
    const outside = writeTree(tempDir(), {
      "index.html": page("<p>outside\n</p>"),
      "index.md": "# outside",
    });
    const dist = writeTree(tempDir(), { "index.html": page("", "/") });
    symlinkSync(outside, join(dist, "linked"));
    symlinkSync(join(outside, "index.html"), join(dist, "page.html"));
    const summary = runPostbuild(dist, config(), navOf({}), noRepo());
    expect(summary.pages).toBe(1);
    expect(readFileSync(join(outside, "index.html"), "utf8")).toBe(page("<p>outside\n</p>"));
    expect(existsSync(join(outside, "index.md"))).toBe(true);
  });

  test("it produces the finished fixture site from Jx's output, and finishing that site changes nothing", () => {
    const finished = copySite();
    const raw = copySite();
    // What the emitter and Jx's own post-processing leave: the 404 page in a folder, Markdown copies, canonical
    // addresses without the trailing slash, the unrewritten sitemap, a search index titled with file names.
    put(join(raw.dist, "404", "index.html"), readFileSync(join(raw.dist, "404.html"), "utf8"));
    drop(join(raw.dist, "404.html"));
    for (const dir of ["", "docs", "docs/guide", "404"])
      put(join(raw.dist, ...dir.split("/").filter(Boolean), "index.md"), "# copy\n");
    for (const file of ["index.html", "docs/index.html", "docs/guide/index.html"]) {
      edit(join(raw.dist, ...file.split("/")), (t) =>
        t
          .replaceAll(/(https:\/\/docs\.example\.test[^"]*?)\/"/g, '$1"')
          .replace('example.test""', 'example.test/"'),
      );
    }
    put(
      join(raw.dist, "sitemap.xml"),
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset><url><loc>https://docs.example.test/docs/guide</loc><lastmod>2026-10-06T00:00:00.000Z</lastmod></url><url><loc>https://docs.example.test/404</loc></url></urlset>\n`,
    );
    edit(join(raw.dist, "search-index.json"), (t) =>
      t.replaceAll(/"title":"(Fixture|Guide)"/g, '"title":"README"'),
    );

    const nav = navOf({
      "/docs/": info("Fixture", "README.md"),
      "/docs/guide/": info("Guide", "guide.md"),
    });
    const cfg = config({
      domain: "docs.example.test",
      repo: "https://github.com/Avunu/docusystem-example",
    });
    const summary = runPostbuild(raw.dist, cfg, nav, noRepo());
    // The copy in the 404 folder goes with the folder, before the copies are counted.
    expect(summary).toMatchObject({ pages: 4, markdownCopies: 3, notFound: true, cname: true });
    expect(summary.canonicals).toBeGreaterThan(0);
    // The search index is compared as data: Jx writes it compactly and so does postbuild.
    const normal = (t: string): string => JSON.stringify(JSON.parse(t));
    const got = readTree(raw.dist);
    const want = readTree(finished.dist);
    expect(Object.keys(got).sort()).toEqual(Object.keys(want).sort());
    for (const [file, text] of Object.entries(got)) {
      expect(file.endsWith(".json") ? normal(text) : text, file).toBe(
        file.endsWith(".json") ? normal(want[file]!) : want[file],
      );
    }

    // The finished site is a fixed point of everything but the code-newline rule of tidy.ts, which needs fresh input.
    const before = readTree(finished.dist);
    const again = runPostbuild(finished.dist, cfg, nav, noRepo());
    expect(again).toMatchObject({
      markdownCopies: 0,
      searchTitles: 0,
      canonicals: 0,
      notFound: true,
    });
    expect(readTree(finished.dist)).toEqual(before);
    expect(
      assertBuild(finished.root, finished.dist, { cname: "docs.example.test", routes: 4 }).filter(
        (a) => !a.ok,
      ),
    ).toEqual([]);
    expect(checkLinks(finished.dist, { nav }).errors).toEqual([]);
  });

  test("the fixture folder holds what the tests below expect", () => {
    expect(listTree(join(OUTPUT_FIXTURES, "site", "built"))).toContain("404.html");
  });
});

test("the text of <title> is escaped, entities that are already there are kept", () => {
  expect(escapeTitle("<title>Array<string> & more</title>")).toBe(
    "<title>Array&lt;string&gt; &amp; more</title>",
  );
  expect(escapeTitle("<title>Tom &amp; Jerry &#38; &copy;</title><p>a < b</p>")).toBe(
    "<title>Tom &amp; Jerry &#38; &copy;</title><p>a < b</p>",
  );
  expect(escapeTitle("<p>no title</p>")).toBe("<p>no title</p>");
});

test("a title that pages/[...path].json already escaped is left as it is", () => {
  const escaped =
    "<title>Evil &lt;/title&gt;&lt;script&gt;x&lt;/script&gt; &amp; Co · Docs</title>";
  expect(escapeTitle(escaped)).toBe(escaped);
});

test("code blocks in a language the build cannot highlight are reported once each", () => {
  const html =
    '<pre><code class="language-bash shiki">x</code></pre><pre><code class="language-rust">y</code></pre><pre><code class="language-rust">z</code></pre><pre><code class="language-vue">v</code></pre><pre><code class="language-text">t</code></pre><pre><code>no language</code></pre>';
  expect(unhighlightedLanguages(html)).toEqual(["rust", "vue"]);
  expect(unhighlightedLanguages("<p>none</p>")).toEqual([]);
});

test("the Markdown copies Jx writes beside pages are removed, other Markdown files are not", () => {
  const dist = writeTree(tempDir(), {
    "index.html": "<p>x</p>",
    "index.md": "# copy",
    "docs/a/index.html": "<p>a</p>",
    "docs/a/index.md": "# copy",
    "docs/lonely/index.md": "# no page next to it",
    "downloads/notes.md": "# a real file",
  });
  expect(dropMarkdownCopies(dist)).toBe(2);
  expect(existsSync(join(dist, "index.md"))).toBe(false);
  expect(existsSync(join(dist, "docs", "a", "index.md"))).toBe(false);
  expect(existsSync(join(dist, "docs", "lonely", "index.md"))).toBe(true);
  expect(existsSync(join(dist, "downloads", "notes.md"))).toBe(true);
});

describe("repository links in the HTML of a page", () => {
  const setup = () => {
    const repo = writeTree(tempDir(), {
      "README.md": "x",
      LICENSE: "x",
      "lib/a.nix": "x",
      "lib/deep/b.py": "x",
      "assets/logo.png": "x",
      "my file.txt": "x",
      "docs/guides/setup.md": "x",
      "docs/guides/example.json": "{}",
      "docs-site/dist/docs/index.html": "x",
      "docs-site/dist/docs/guides/setup/index.html": "x",
    });
    return {
      repo,
      context: {
        dist: join(repo, "docs-site", "dist"),
        repoRoot: repo,
        docsDir: join(repo, "docs"),
        repoUrl: "https://github.com/Avunu/x",
        branch: "main",
      },
    };
  };

  test("a link finds its file next to the document first, then at the repository root", () => {
    const { context } = setup();
    expect(repoTarget("example.json", "guides", context)).toBe("docs/guides/example.json");
    expect(repoTarget("lib/a.nix", "", context)).toBe("lib/a.nix");
    expect(repoTarget("../../lib/deep/b.py", "guides", context)).toBe("lib/deep/b.py");
    expect(repoTarget("LICENSE", "guides", context)).toBe("LICENSE");
    expect(repoTarget("my%20file.txt", "", context)).toBe("my file.txt");
    expect(repoTarget("missing.txt", "", context)).toBeNull();
    expect(repoTarget("../../../outside", "guides", context)).toBeNull();
  });

  test("a link out of the repository is never a repository link, even when the file exists", () => {
    const { context, repo } = setup();
    const outside = writeTree(tempDir(), { "secret.txt": "x" });
    expect(repoTarget(join(outside, "secret.txt"), "", context)).toBeNull();
    // `..foo` is a name, not a step up.
    writeTree(repo, { "..hidden": "x" });
    expect(repoTarget("..hidden", "", context)).toBe("..hidden");
  });

  test("absolute, external and fragment-only links are never repository links", () => {
    const { context } = setup();
    for (const href of [
      "/lib/a.nix",
      "https://example.com/x",
      "mailto:a@b.c",
      "#top",
      "",
      "//cdn/x",
    ])
      expect(repoTarget(href, "", context)).toBeNull();
  });

  test("GitHub addresses: blob for files, tree for folders, raw for images", () => {
    const { context } = setup();
    expect(githubUrl(context, "lib/a.nix", false)).toBe(
      "https://github.com/Avunu/x/blob/main/lib/a.nix",
    );
    expect(githubUrl(context, "lib", false)).toBe("https://github.com/Avunu/x/tree/main/lib");
    expect(githubUrl(context, "assets/logo.png", true)).toBe(
      "https://github.com/Avunu/x/raw/main/assets/logo.png",
    );
    expect(githubUrl(context, "docs/guides", false)).toBe(
      "https://github.com/Avunu/x/tree/main/docs/guides",
    );
    expect(githubUrl(context, "my file.txt", false)).toBe(
      "https://github.com/Avunu/x/blob/main/my%20file.txt",
    );
    expect(githubUrl(context, "", false)).toBe("https://github.com/Avunu/x/tree/main");
  });

  test("a link that is already a built page is left alone, a repository file is rewritten", () => {
    const { context } = setup();
    const html =
      '<p><a href="guides/setup/">page</a> <a href="lib/a.nix">code</a> <a href="lib/">folder</a> <img src="assets/logo.png" alt=""> <a href="https://x.dev/">ext</a> <a href="nope">nope</a></p>';
    const { html: out, links } = rewriteRepoLinks(html, "/docs/", "", context);
    expect(out).toContain('href="guides/setup/"');
    expect(out).toContain('href="https://github.com/Avunu/x/blob/main/lib/a.nix"');
    expect(out).toContain('href="https://github.com/Avunu/x/tree/main/lib"');
    expect(out).toContain('src="https://github.com/Avunu/x/raw/main/assets/logo.png"');
    expect(out).toContain('href="nope"');
    expect(links.map((l) => l.from)).toEqual(["lib/a.nix", "lib/", "assets/logo.png"]);
    expect(links[0]).toEqual({
      page: "/docs/",
      from: "lib/a.nix",
      to: "https://github.com/Avunu/x/blob/main/lib/a.nix",
    });
  });

  test("a fragment survives the rewrite", () => {
    const { context } = setup();
    const { html } = rewriteRepoLinks('<a href="lib/a.nix#L10">x</a>', "/docs/", "", context);
    expect(html).toContain("/blob/main/lib/a.nix#L10");
  });

  test("entities in the attribute are read, and the new address is written escaped", () => {
    const { context } = setup();
    const { html } = rewriteRepoLinks(
      '<a href="my%20file.txt?a=1&amp;b=2">x</a>',
      "/docs/",
      "",
      context,
    );
    expect(html).toContain('href="https://github.com/Avunu/x/blob/main/my%20file.txt"');
  });

  test("tags other than a and img, and other attributes, are not touched", () => {
    const { context } = setup();
    const html = '<link href="lib/a.nix"><a name="lib/a.nix">x</a><img alt="x" srcset="lib/a.nix">';
    expect(rewriteRepoLinks(html, "/docs/", "", context)).toEqual({ html, links: [] });
  });
});
