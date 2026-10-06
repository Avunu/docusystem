import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  checkLinks,
  decodeEntities,
  distFiles,
  fileFor,
  formatIssues,
  htmlPages,
  idsOf,
  referencesOf,
  resolveReference,
  routeOfFile,
  strayExpression,
} from "../../src/lib/links.js";
import type { NavData } from "../../src/lib/types.js";
import { slash, tempDir, writeTree } from "../support/index.js";
import { copySite, drop, edit, put, swap } from "./helpers.js";

const page = (body: string, title = "T"): string =>
  `<!DOCTYPE html><html><head><title>${title}</title><meta name="description" content="d"></head><body>${body}</body></html>`;
const fixture = (extra: Record<string, string> = {}): string =>
  writeTree(tempDir(), {
    "index.html": page('<h1>Home</h1><a href="/docs/">docs</a>'),
    "docs/index.html": page(
      '<h1 id="home">Home</h1><h2 id="sec">S</h2><a href="getting-started/">gs</a> <a href="#sec">self</a> <a href="/docs/getting-started/#install">deep</a><img src="/brand/x.svg" alt="">',
    ),
    "docs/getting-started/index.html": page(
      '<h1>GS</h1><h2 id="install">I</h2><a href="../">up</a>',
    ),
    "brand/x.svg": "<svg/>",
    ...extra,
  });

const link = (url: string) => ({ label: url, url });
const navOf = (o: Partial<NavData>): NavData => ({
  home: link("/docs/"),
  loose: [],
  sections: [],
  expandAll: true,
  pages: {},
  flat: [],
  featured: [],
  ...o,
});

test("references are read from href and src, and not from scripts or comments", () => {
  const refs = referencesOf(
    '<a href="/a/">a</a><img src="b.png"><script>var x = \'<a href="/not/">\'</script><!-- <a href="/no/"> --><link href="/c.css" rel="stylesheet">',
  );
  expect(refs.map((r) => r.value)).toEqual(["/a/", "b.png", "/c.css"]);
  expect(refs.map((r) => r.tag)).toEqual(["a", "img", "link"]);
});

test("entities in an attribute value are decoded before the value is used", () => {
  expect(decodeEntities("a&amp;b &quot;c&quot; &#39;d&#39; &lt;e&gt; &#x41;&#66; &nbsp;|")).toBe(
    "a&b \"c\" 'd' <e> AB \u00a0|",
  );
  expect(decodeEntities("&bogus; &#0; &#xD800; &#99999999;")).toBe(
    "&bogus; &#0; &#xD800; &#99999999;",
  );
  expect(referencesOf('<a href="/a/?x=1&amp;y=2">a</a>')[0]?.value).toBe("/a/?x=1&y=2");
  expect([...idsOf('<h2 id="a&amp;b">x</h2><a name="old">y</a>')].sort()).toEqual(["a&b", "old"]);
});

test("references resolve against the page they are on", () => {
  expect(resolveReference("/docs/a/", "../b/")).toEqual({ path: "/docs/b/", hash: "", query: "" });
  expect(resolveReference("/docs/a/", "c/#x%20y")).toEqual({
    path: "/docs/a/c/",
    hash: "x y",
    query: "",
  });
  expect(resolveReference("/docs/a/", "#top")).toEqual({
    path: "/docs/a/",
    hash: "top",
    query: "",
  });
  expect(resolveReference("/docs/a/", "/x/y.png?v=1")).toEqual({
    path: "/x/y.png",
    hash: "",
    query: "?v=1",
  });
  expect(resolveReference("/docs/a/", "https://example.com")).toBeNull();
  expect(resolveReference("/docs/a/", "mailto:x@y.z")).toBeNull();
  expect(resolveReference("/docs/a/", "//cdn.example/x")).toBeNull();
  expect(resolveReference("/docs/a/", "")).toBeNull();
  // A step up past the root stays at the root; a bad escape is left as written and will not resolve.
  expect(resolveReference("/docs/", "../../../x/")?.path).toBe("/x/");
  expect(resolveReference("/docs/", "%E0%A4%A")?.path).toBe("/docs/%E0%A4%A");
});

test("files map to the addresses they are served at", () => {
  expect(routeOfFile("/d", "/d/index.html")).toBe("/");
  expect(routeOfFile("/d", "/d/docs/a/index.html")).toBe("/docs/a/");
  expect(routeOfFile("/d", "/d/404.html")).toBe("/404.html");
  expect(routeOfFile("/d", "/d/docs/myindex.html")).toBe("/docs/myindex.html");
  expect(routeOfFile("/d", "/d/docs/index.html.html")).toBe("/docs/index.html.html");
});

test("fileFor finds a file, a folder's page, and says when the slash is missing", () => {
  const dist = fixture();
  expect(fileFor(dist, "/docs/")).toEqual({ file: join(dist, "docs", "index.html"), exact: true });
  expect(fileFor(dist, "/brand/x.svg")).toEqual({
    file: join(dist, "brand", "x.svg"),
    exact: true,
  });
  expect(fileFor(dist, "/docs")).toEqual({ file: join(dist, "docs", "index.html"), exact: false });
  expect(fileFor(dist, "/brand/")).toBeNull();
  expect(fileFor(dist, "/nope")).toBeNull();
  expect(fileFor(dist, "/bad\u0000name")).toBeNull();
});

describe("what a built site is", () => {
  test("pages and files are listed sorted, from regular files only", () => {
    const dist = fixture();
    expect(htmlPages(dist).map((f) => slash(f.slice(dist.length + 1)))).toEqual([
      "docs/getting-started/index.html",
      "docs/index.html",
      "index.html",
    ]);
    expect(distFiles(dist)).toContain("brand/x.svg");
  });

  test("a symbolic link is not followed: nothing outside the site is read or reported", () => {
    const outside = writeTree(tempDir(), {
      "index.html": page("<h1>x</h1><a href='/nowhere/'>x</a>"),
    });
    const dist = fixture();
    symlinkSync(outside, join(dist, "linked"));
    symlinkSync(join(outside, "index.html"), join(dist, "docs", "alias.html"));
    expect(htmlPages(dist)).toHaveLength(3);
    expect(distFiles(dist).some((f) => f.startsWith("linked") || f.endsWith("alias.html"))).toBe(
      false,
    );
    expect(checkLinks(dist).errors).toEqual([]);
  });
});

describe("checkLinks", () => {
  test("a healthy site has no errors", () => {
    const report = checkLinks(fixture());
    expect(report.errors).toEqual([]);
    expect(report.pages).toBe(3);
    expect(report.checked).toBeGreaterThan(5);
  });

  test("a missing page, a missing anchor and a link to a Markdown file are errors", () => {
    const dist = fixture({
      "docs/bad/index.html": page(
        '<h1>B</h1><a href="/docs/nope/">1</a><a href="/docs/#missing">2</a><a href="other.md">3</a><img src="/gone.png" alt="">',
      ),
    });
    const messages = checkLinks(dist).errors.map((e) => e.message);
    expect(messages.some((m) => m.includes('"/docs/nope/" does not exist'))).toBe(true);
    expect(messages.some((m) => m.includes('no element with id "missing"'))).toBe(true);
    expect(messages.some((m) => m.includes("Markdown file"))).toBe(true);
    expect(messages.some((m) => m.includes("/gone.png"))).toBe(true);
  });

  test("a link without the trailing slash works but is a warning", () => {
    const report = checkLinks(
      fixture({ "docs/x/index.html": page('<h1>X</h1><a href="/docs/getting-started">gs</a>') }),
    );
    expect(report.errors).toEqual([]);
    expect(report.warnings.some((w) => w.message.includes("trailing slash"))).toBe(true);
  });

  test("every page needs exactly one h1 and a title", () => {
    const report = checkLinks(
      fixture({
        "docs/two/index.html": page("<h1>a</h1><h1>b</h1>"),
        "docs/none/index.html": "<html><body><p>x</p></body></html>",
      }),
    );
    const messages = report.errors.map((e) => `${e.page} ${e.message}`);
    expect(messages.some((m) => m.includes("/docs/two/") && m.includes("2 <h1>"))).toBe(true);
    expect(messages.some((m) => m.includes("/docs/none/") && m.includes("0 <h1>"))).toBe(true);
    expect(messages.some((m) => m.includes("/docs/none/") && m.includes("no <title>"))).toBe(true);
  });

  test("a page without a meta description is a warning, the 404 page is exempt", () => {
    const report = checkLinks(
      fixture({
        "docs/bare/index.html": "<html><head><title>t</title></head><body><h1>b</h1></body></html>",
        "404.html": "<html><head><title>t</title></head><body><h1>b</h1></body></html>",
      }),
    );
    expect(
      report.warnings.filter((w) => w.message === "no meta description").map((w) => w.page),
    ).toEqual(["/docs/bare/"]);
  });

  test("a duplicate id is a warning", () => {
    const report = checkLinks(
      fixture({ "docs/dup/index.html": page('<h1 id="a">a</h1><h2 id="a">b</h2>') }),
    );
    expect(report.errors).toEqual([]);
    expect(report.warnings.map((w) => w.message)).toContain('duplicate id "a"');
  });

  test("a template expression that reached the page unevaluated is an error, escaped code is not", () => {
    const dist = fixture({
      "docs/stray/index.html": page('<h1>S</h1><a href="/">${state.config.data.name} home</a>'),
      "docs/code/index.html": page(
        "<h1>C</h1><pre><code>echo &#36;{state.x} and ${HOME}</code></pre>",
      ),
    });
    const messages = checkLinks(dist).errors.map((e) => `${e.page} ${e.message}`);
    expect(messages.some((m) => m.includes("/docs/stray/") && m.includes("unevaluated"))).toBe(
      true,
    );
    expect(messages.some((m) => m.includes("/docs/code/"))).toBe(false);
  });

  test("strayExpression names the first expression and ignores scripts and comments", () => {
    expect(strayExpression("<p>${state.config.data.name}</p>")).toBe("${state.config.data.name}");
    expect(strayExpression("<p>${$map.item}</p>")).toBe("${$map.item}");
    expect(strayExpression("<p>cut off: ${state.config.da</p>")).toBe("${state.config.da</p>");
    expect(
      strayExpression("<script>`${state.x}`</script><!-- ${state.y} --><p>${HOME}</p>"),
    ).toBeNull();
  });

  test("search results must be pages or headings that exist", () => {
    const good = JSON.stringify({
      documents: [
        { url: "/docs/" },
        { url: "/docs/#sec" },
        { url: "/docs/getting-started/#install" },
      ],
    });
    expect(checkLinks(fixture({ "search-index.json": good })).errors).toEqual([]);
    const bad = JSON.stringify({ documents: [{ url: "/docs/#nope" }, { url: "/docs/missing/" }] });
    expect(checkLinks(fixture({ "search-index.json": bad })).errors).toHaveLength(2);
  });

  test("a search index that is not JSON, and a long list of bad results, are reported once", () => {
    expect(
      checkLinks(fixture({ "search-index.json": "{" })).errors.map((e) => `${e.page} ${e.message}`),
    ).toEqual(["/search-index.json is not valid JSON"]);
    const many = JSON.stringify({
      documents: Array.from({ length: 25 }, (_v, i) => ({ url: `/gone/${i}/` })),
    });
    const errors = checkLinks(fixture({ "search-index.json": many })).errors;
    expect(errors).toHaveLength(21);
    expect(errors.at(-1)?.message).toBe("5 more result addresses are not pages or headings");
  });

  test("every sidebar entry must have been built, and every built docs page must be in the sidebar", () => {
    const nav = navOf({
      loose: [link("/docs/getting-started/")],
      sections: [{ label: "G", url: null, urls: [], pages: [link("/docs/ghost/")], groups: [] }],
      pages: Object.fromEntries(
        ["/docs/", "/docs/getting-started/", "/docs/ghost/"].map((url) => [
          url,
          { title: "", description: "", section: "", prev: null, next: null, edit: "" },
        ]),
      ),
    });
    const report = checkLinks(fixture({ "docs/extra/index.html": page("<h1>E</h1>") }), { nav });
    const messages = report.errors.map((e) => e.message);
    expect(messages.some((m) => m.includes("/docs/ghost/"))).toBe(true);
    expect(messages.some((m) => m.includes("not in the sidebar data"))).toBe(true);
  });

  test("grouped pages, previous and next, and the featured cards are crawled too", () => {
    const nav = navOf({
      sections: [
        {
          label: "S",
          url: null,
          urls: [],
          pages: [],
          groups: [{ label: "G", url: null, urls: [], pages: [link("/docs/in-a-group/")] }],
        },
      ],
      flat: [{ title: "In flat", url: "/docs/in-flat/" }],
    });
    const messages = checkLinks(fixture(), { nav }).errors.map((e) => e.message);
    expect(messages.filter((m) => m.startsWith("the sidebar links to"))).toHaveLength(2);
  });

  test("a sidebar page named like a property of Object is not found in the nav data by accident", () => {
    const nav = navOf({
      pages: {
        "/docs/": { title: "", description: "", section: "", prev: null, next: null, edit: "" },
      },
    });
    const dist = fixture({ "docs/constructor/index.html": page("<h1>c</h1>") });
    const messages = checkLinks(dist, { nav }).errors.map((e) => `${e.page} ${e.message}`);
    expect(
      messages.some((m) =>
        m.startsWith("/docs/constructor/ was built but is not in the sidebar data"),
      ),
    ).toBe(true);
  });

  test("a site whose documentation home was not built says so", () => {
    const dist = writeTree(tempDir(), { "index.html": page("<h1>Home</h1>") });
    const messages = checkLinks(dist, { nav: navOf({}) }).errors.map(
      (e) => `${e.page} ${e.message}`,
    );
    expect(messages.some((m) => m.startsWith("/docs/ the documentation home was not built"))).toBe(
      true,
    );
  });

  test("a callout marker that stayed text is an error, one in code is not", () => {
    const dist = fixture({
      "docs/marker/index.html": page("<h1>M</h1><blockquote><p>[!QUESTION] why?</p></blockquote>"),
      "docs/code/index.html": page(
        "<h1>C</h1><pre><code>&gt; [!NOTE]</code></pre><p><code>[!TIP]</code></p>",
      ),
    });
    const messages = checkLinks(dist).errors.map((e) => `${e.page} ${e.message}`);
    expect(messages.some((m) => m.includes("/docs/marker/") && m.includes("[!QUESTION]"))).toBe(
      true,
    );
    expect(messages.some((m) => m.includes("/docs/code/"))).toBe(false);
  });

  test("issues are listed one per line", () => {
    expect(
      formatIssues([
        { page: "/a/", message: "x" },
        { page: "/b/", message: "y" },
      ]),
    ).toBe("  /a/  x\n  /b/  y");
    expect(formatIssues([])).toBe("");
  });
});

describe("checkLinks on the hand-built site", () => {
  const nav = navOf({
    pages: Object.fromEntries(
      ["/docs/", "/docs/guide/"].map((url) => [
        url,
        { title: "", description: "", section: "", prev: null, next: null, edit: "" },
      ]),
    ),
    flat: [
      { title: "Fixture", url: "/docs/" },
      { title: "Guide", url: "/docs/guide/" },
    ],
  });

  test("is clean with the sidebar crawled too", () => {
    const { dist } = copySite();
    const report = checkLinks(dist, { nav });
    expect(report.errors).toEqual([]);
    expect(report.pages).toBe(4);
  });

  test("finds a broken anchor, a missing asset and a missing page each in its place", () => {
    const { dist } = copySite();
    edit(join(dist, "docs", "index.html"), (t) => swap(t, 'href="#intro"', 'href="#outro"'));
    edit(join(dist, "index.html"), (t) =>
      swap(
        t,
        '<link rel="icon" href="/favicon.ico" sizes="32x32">',
        '<link rel="icon" href="/favicon.png">',
      ),
    );
    drop(join(dist, "docs", "guide", "index.html"));
    const messages = checkLinks(dist, { nav }).errors.map((e) => `${e.page} ${e.message}`);
    expect(messages).toContain('/docs/ href="#outro": the page has no element with id "outro"');
    expect(messages).toContain('/ href="/favicon.png" does not exist');
    expect(messages.some((m) => m.startsWith("(sidebar) the sidebar links to /docs/guide/"))).toBe(
      true,
    );
    expect(
      messages.some(
        (m) =>
          m.includes("/docs/guide/ does not exist") || m.includes('href="guide/" does not exist'),
      ),
    ).toBe(true);
  });

  test("a page with a bad link is reported under its own address", () => {
    const { dist } = copySite();
    put(join(dist, "docs", "extra", "index.html"), page('<h1>E</h1><a href="../gone/">x</a>'));
    const errors = checkLinks(dist).errors;
    expect(errors.map((e) => e.page)).toContain("/docs/extra/");
  });
});
