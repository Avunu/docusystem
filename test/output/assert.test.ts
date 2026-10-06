import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  assertBuild,
  componentsOf,
  emptyComponents,
  emptyLinks,
  formatAssertion,
  titleHoldsMarkup,
} from "../../src/lib/assert.js";
import { tempDir } from "../support/index.js";
import { copySite, drop, edit, put, swap, type Site } from "./helpers.js";

// The order of the assertions of step 12, as assertBuild returns them.
const A = {
  components: 0,
  hollow: 1,
  links: 2,
  h1: 3,
  title: 4,
  stray: 5,
  cname: 6,
  fonts: 7,
  faces: 8,
  services: 9,
  favicons: 10,
  nojekyll: 11,
  search: 12,
  sitemap: 13,
  notFound: 14,
  copies: 15,
  switcher: 16,
  routes: 17,
} as const;

const DOMAIN = "docs.example.test";
/** The fixture has four pages: the landing page, the documentation home, one guide and the 404 page. */
const PAGES = 4;

const run = (site: Site, routes: number | null = PAGES) =>
  assertBuild(site.root, site.dist, { cname: DOMAIN, routes });
const failing = (site: Site, routes: number | null = PAGES): number[] =>
  run(site, routes).flatMap((a, i) => (a.ok ? [] : [i]));

describe("the passing fixture", () => {
  test("passes every assertion, in the order of the record", () => {
    const results = run(copySite());
    expect(results).toHaveLength(18);
    expect(results.filter((a) => !a.ok)).toEqual([]);
    expect(results.map((a) => a.message)).toEqual([
      "3 components emitted as components/<tag>.js",
      "no page has an empty, un-rendered component",
      "no page has a link without text, image or aria-label",
      "every page has exactly one <h1>",
      "every page's <title> is text only, with no markup after it",
      "no unevaluated ${state text on any page",
      "CNAME says docs.example.test",
      "1 self-hosted font file in fonts/",
      "1 @font-face URL, all local and present in the site",
      "no third-party font host is referenced",
      "favicon.svg and favicon.ico are published",
      ".nojekyll is published",
      "search-index.json has an entry for each of the 2 documentation pages",
      "sitemap.xml lists 3 pages on docs.example.test",
      "404.html is published and there is no /404/ folder",
      "no Markdown copies of pages (index.md beside index.html)",
      "the project switcher is pre-rendered from the catalog (1 project in 1 group)",
      "4 pages built (4 expected)",
    ]);
  });

  test("a route count of null leaves the count unchecked and everything else as it was", () => {
    const results = run(copySite(), null);
    expect(results).toHaveLength(18 - 1);
    expect(results.every((a) => a.ok)).toBe(true);
  });

  test("formatAssertion prints ok and FAIL lines", () => {
    expect(formatAssertion({ ok: true, message: "fine" })).toBe("ok   fine");
    expect(formatAssertion({ ok: false, message: "broken" })).toBe("FAIL broken");
  });
});

// Each failing fixture is the passing one with one change, so that what fails is exactly what the
// change broke (and the passing and the failing fixture cannot drift apart).
interface Case {
  name: string;
  change: (site: Site) => void;
  fails: number[];
  routes?: number | null;
  says?: RegExp;
}
const index = (site: Site) => join(site.dist, "index.html");
const guide = (site: Site) => join(site.dist, "docs", "guide", "index.html");
const dist = (site: Site, rel: string) => join(site.dist, ...rel.split("/"));

const CASES: Case[] = [
  {
    name: "a component module was not emitted",
    change: (s) => drop(dist(s, "components/docs-header.js")),
    fails: [A.components],
    says: /not emitted as components\/<tag>\.js: docs-header/,
  },
  {
    name: "a component file of the root is not JSON",
    change: (s) => put(join(s.root, "components", "broken.json"), "{ not json"),
    fails: [A.components],
    says: /not valid JSON: components\/broken\.json/,
  },
  {
    name: "the root has no components",
    change: (s) => drop(join(s.root, "components")),
    fails: [A.components],
    says: /no components/,
  },
  {
    name: "a component is named after its tag, not its file",
    change: (s) => {
      put(join(s.root, "components", "footer.json"), '{ "tagName": "docs-footer" }');
    },
    fails: [A.components],
    says: /docs-footer/,
  },
  {
    name: "a registered component is left empty on the landing page",
    change: (s) =>
      edit(index(s), (t) => swap(t, /(<project-switcher\b[^>]*>)<button[\s\S]*?<\/button>/, "$1")),
    fails: [A.hollow],
    says: /\/ \(project-switcher\)/,
  },
  {
    name: "a registered component holds only white space",
    change: (s) =>
      edit(guide(s), (t) =>
        swap(t, /<docs-prose>[\s\S]*<\/docs-prose>/, "<docs-prose>\n  </docs-prose>"),
      ),
    fails: [A.hollow, A.h1],
    says: /\/docs\/guide\/ \(docs-prose\)/,
  },
  {
    name: "a raw HTML anchor came out as <a href></a>text",
    change: (s) => edit(guide(s), (t) => swap(t, "<p>Back", "<p><a href></a>Raw anchor. Back")),
    fails: [A.links],
    says: /\/docs\/guide\/ \(<a href>\)\. A raw HTML <a href> in that page's Markdown .*`docusystem lint` lists it with its file and line/,
  },
  {
    name: "a link has an empty href attribute value and no text",
    change: (s) => edit(guide(s), (t) => swap(t, "<p>Back", '<p><a href="/docs/"> </a>Back')),
    fails: [A.links],
  },
  {
    name: "a page has two <h1>",
    change: (s) => edit(guide(s), (t) => swap(t, "<p>Back", "<h1>Again</h1><p>Back")),
    fails: [A.h1],
    says: /\/docs\/guide\/ \(2\)/,
  },
  {
    name: "a page has no <h1>",
    change: (s) => edit(dist(s, "404.html"), (t) => swap(t, "<h1>Page not found</h1>", "")),
    fails: [A.h1],
    says: /\/404\.html \(0\)/,
  },
  {
    name: "a title that holds </title> ended the element, and a script follows it in the head",
    change: (s) =>
      edit(guide(s), (t) =>
        swap(
          t,
          /<title>[^<]*<\/title>/,
          '<title>Evil </title><script>document.documentElement.setAttribute("x","1")</script> · Docs</title>',
        ),
      ),
    fails: [A.title],
    says: /the <title> ends early.*\/docs\/guide\//,
  },
  {
    name: "a title that holds </title> and then </head> and a body is not taken for the end of the head",
    change: (s) =>
      edit(guide(s), (t) =>
        swap(
          t,
          /<title>[^<]*<\/title>/,
          "<title>Evil </title></head><body><img src=x onerror=alert(1)><title>y</title>",
        ),
      ),
    fails: [A.title],
  },
  {
    name: "a title that closes the element in capitals, with a space or a slash",
    change: (s) =>
      edit(guide(s), (t) =>
        swap(t, /<title>[^<]*<\/title>/, "<title>a</TITLE ><script>x</script></title/>"),
      ),
    fails: [A.title],
  },
  {
    name: "a template expression reached the page unevaluated",
    change: (s) => edit(guide(s), (t) => swap(t, "<p>Back", "<p>${state.config.data.name} Back")),
    fails: [A.stray],
    says: /\/docs\/guide\/ \(\$\{state\.config\.data\.name\}\)/,
  },
  {
    name: "the CNAME names another domain",
    change: (s) => put(dist(s, "CNAME"), "someone-else.example.test\n"),
    fails: [A.cname],
    says: /CNAME is someone-else\.example\.test, it must say docs\.example\.test/,
  },
  {
    name: "there is no CNAME",
    change: (s) => drop(dist(s, "CNAME")),
    fails: [A.cname],
    says: /CNAME is missing/,
  },
  {
    name: "there is no font file",
    change: (s) => drop(dist(s, "fonts/figtree-latin-wght-normal.woff2")),
    fails: [A.fonts, A.faces],
    says: /no fonts\/\*\.woff2/,
  },
  {
    name: "an @font-face points at a font on another host",
    change: (s) =>
      edit(index(s), (t) =>
        swap(
          t,
          '/fonts/figtree-latin-wght-normal.woff2")',
          'https://cdn.example.org/figtree.woff2")',
        ),
      ),
    fails: [A.faces],
    says: /https:\/\/cdn\.example\.org\/figtree\.woff2 is not local/,
  },
  {
    name: "an @font-face points at a file that is not in the site",
    change: (s) =>
      edit(index(s), (t) =>
        swap(t, 'url("/fonts/figtree-latin-wght-normal.woff2")', 'url("/fonts/missing.woff2")'),
      ),
    fails: [A.faces],
    says: /\/fonts\/missing\.woff2 is not in the site/,
  },
  {
    name: "no @font-face rule is left",
    change: (s) => edit(index(s), (t) => swap(t, /@font-face \{[^}]*\}/, "")),
    fails: [A.faces],
    says: /no @font-face rule/,
  },
  {
    name: "an @font-face points at a font service",
    change: (s) =>
      edit(index(s), (t) =>
        swap(
          t,
          '/fonts/figtree-latin-wght-normal.woff2")',
          '//fonts.gstatic.com/s/figtree.woff2")',
        ),
      ),
    fails: [A.faces, A.services],
    says: /fonts\.gstatic\.com/,
  },
  {
    name: "a stylesheet link points at a font service",
    change: (s) =>
      edit(guide(s), (t) =>
        swap(
          t,
          "<title>",
          '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Figtree"><title>',
        ),
      ),
    fails: [A.services],
    says: /fonts\.googleapis\.com/,
  },
  {
    name: "a CSS file imports a font service",
    change: (s) =>
      put(dist(s, "components/theme.css"), '@import url("https://use.typekit.net/abc1234.css");\n'),
    fails: [A.services],
    says: /use\.typekit\.net/,
  },
  {
    name: "favicon.ico is missing",
    change: (s) => drop(dist(s, "favicon.ico")),
    fails: [A.favicons],
    says: /missing: favicon\.ico/,
  },
  {
    name: "favicon.svg is missing",
    change: (s) => drop(dist(s, "favicon.svg")),
    fails: [A.favicons],
    says: /missing: favicon\.svg/,
  },
  {
    name: ".nojekyll is missing",
    change: (s) => drop(dist(s, ".nojekyll")),
    fails: [A.nojekyll],
  },
  {
    name: "the search index lacks a documentation page",
    change: (s) =>
      edit(dist(s, "search-index.json"), (t) => swap(t, /,\{"id":"docs:guide"[^}]*\}/, "")),
    fails: [A.search],
    says: /no entry for: \/docs\/guide\//,
  },
  {
    name: "there is no search index",
    change: (s) => drop(dist(s, "search-index.json")),
    fails: [A.search],
    says: /search-index\.json is missing/,
  },
  {
    name: "the search index is not JSON",
    change: (s) => put(dist(s, "search-index.json"), "{"),
    fails: [A.search],
    says: /not valid JSON/,
  },
  {
    name: "the search index is in a shape that is not Jx's",
    change: (s) => put(dist(s, "search-index.json"), '{"version":1}'),
    fails: [A.search],
    says: /no "documents" list/,
  },
  {
    name: "the sitemap lists another domain",
    change: (s) =>
      edit(dist(s, "sitemap.xml"), (t) =>
        swap(t, "https://docs.example.test/docs/guide/", "https://other.example.test/docs/guide/"),
      ),
    fails: [A.sitemap],
    says: /other\.example\.test\/docs\/guide\/ is not on docs\.example\.test/,
  },
  {
    name: "the sitemap lists a page without its trailing slash",
    change: (s) =>
      edit(dist(s, "sitemap.xml"), (t) =>
        swap(t, "https://docs.example.test/docs/guide/", "https://docs.example.test/docs/guide"),
      ),
    fails: [A.sitemap],
    says: /lacks the trailing slash/,
  },
  {
    name: "the sitemap lists the 404 page",
    change: (s) =>
      edit(dist(s, "sitemap.xml"), (t) =>
        swap(t, "</urlset>", "<url><loc>https://docs.example.test/404.html</loc></url></urlset>"),
      ),
    fails: [A.sitemap],
    says: /is the 404 page/,
  },
  {
    name: "the sitemap is Jx's unrewritten one with no pages",
    change: (s) => put(dist(s, "sitemap.xml"), '<?xml version="1.0"?><urlset></urlset>'),
    fails: [A.sitemap],
    says: /lists no page/,
  },
  {
    name: "there is no sitemap",
    change: (s) => drop(dist(s, "sitemap.xml")),
    fails: [A.sitemap],
    says: /sitemap\.xml is missing/,
  },
  {
    name: "404.html is missing",
    change: (s) => drop(dist(s, "404.html")),
    fails: [A.notFound, A.routes],
    says: /404\.html is missing/,
  },
  {
    name: "a /404/ folder is published",
    change: (s) =>
      put(dist(s, "404/index.html"), "<!DOCTYPE html><title>Not found</title><h1>Not found</h1>"),
    fails: [A.notFound],
    says: /a \/404\/ folder is published/,
  },
  {
    name: "Jx's Markdown copy of a page is published",
    change: (s) => put(dist(s, "docs/guide/index.md"), "# Guide\n"),
    fails: [A.copies],
    says: /docs\/guide\/index\.md/,
  },
  {
    name: "the landing page has no project switcher",
    change: (s) =>
      edit(index(s), (t) => swap(t, /<project-switcher\b[\s\S]*?<\/project-switcher>/, "")),
    fails: [A.switcher],
    says: /no <project-switcher>/,
  },
  {
    name: "the project switcher was not given its data",
    change: (s) => edit(index(s), (t) => swap(t, / data-jx-props="[^"]*"/, "")),
    fails: [A.switcher],
    says: /no data-jx-props/,
  },
  {
    name: "the project switcher was pre-rendered from an empty catalog",
    change: (s) =>
      edit(index(s), (t) => swap(t, /&quot;items&quot;:\[.*?\]\}\]/, "&quot;items&quot;:[]}]")),
    fails: [A.switcher],
    says: /no project in it/,
  },
  {
    name: "the project switcher's data is not JSON",
    change: (s) => edit(index(s), (t) => swap(t, /data-jx-props="[^"]*"/, 'data-jx-props="{nope"')),
    fails: [A.switcher],
    says: /not valid JSON/,
  },
  {
    name: "the landing page is missing",
    change: (s) => drop(index(s)),
    // The fonts are declared in the landing page's own <style>, so they go with it.
    fails: [A.faces, A.switcher, A.routes],
    says: /index\.html\) is missing/,
  },
  {
    name: "Jx dropped a route",
    change: () => undefined,
    routes: PAGES + 3,
    fails: [A.routes],
    says: /4 pages built, 7 expected: Jx dropped 3 routes/,
  },
];

describe("each assertion fails on a fixture that breaks it, and on that alone", () => {
  for (const c of CASES) {
    test(c.name, () => {
      const site = copySite();
      c.change(site);
      const results = run(site, c.routes ?? PAGES);
      expect(results.flatMap((a, i) => (a.ok ? [] : [i]))).toEqual(c.fails);
      if (c.says) {
        const message = results
          .filter((a) => !a.ok)
          .map((a) => a.message)
          .join("\n");
        expect(message).toMatch(c.says);
      }
    });
  }

  test("the case list covers every assertion", () => {
    const covered = new Set(CASES.flatMap((c) => c.fails));
    expect([...covered].sort((a, b) => a - b)).toEqual(Object.values(A));
  });
});

describe("what the assertions accept", () => {
  test("a page that the search index lists only by its headings is covered", () => {
    const site = copySite();
    edit(join(site.dist, "search-index.json"), (t) =>
      swap(t, '"url":"/docs/guide/","title"', '"url":"/docs/guide/#top","title"'),
    );
    expect(failing(site)).toEqual([]);
  });

  test("a lonely index.md, with no page beside it, is somebody's file", () => {
    const site = copySite();
    put(join(site.dist, "downloads", "index.md"), "# a real file\n");
    expect(failing(site)).toEqual([]);
  });

  test("a font embedded as a data: URL needs no file, a local one with a query string does", () => {
    const site = copySite();
    edit(join(site.dist, "index.html"), (t) =>
      swap(
        t,
        "}\n:root",
        "}\n@font-face { font-family: A; src: url(data:font/woff2;base64,AAAA) }\n@font-face { font-family: B; src: url(/fonts/figtree-latin-wght-normal.woff2?v=2) }\n:root",
      ),
    );
    expect(failing(site)).toEqual([]);
  });

  test("an @font-face in a stylesheet file is resolved against that file", () => {
    const site = copySite();
    put(
      join(site.dist, "components", "fonts.css"),
      '@font-face { font-family: C; src: url("../fonts/figtree-latin-wght-normal.woff2") }\n',
    );
    expect(failing(site)).toEqual([]);
    put(
      join(site.dist, "components", "fonts.css"),
      '@font-face { font-family: C; src: url("../fonts/other.woff2") }\n',
    );
    expect(failing(site)).toEqual([A.faces]);
  });

  test("a font service named in the text of a page is not a reference to it", () => {
    const site = copySite();
    edit(join(site.dist, "docs", "guide", "index.html"), (t) =>
      swap(t, "<p>Back", "<p>We never load fonts.googleapis.com. Back"),
    );
    expect(failing(site)).toEqual([]);
  });

  test("a page with more routes than expected passes (a file of public/ is a page too)", () => {
    const site = copySite();
    put(join(site.dist, "google-verification.html"), "<!DOCTYPE html><title>v</title><h1>v</h1>");
    expect(failing(site)).toEqual([]);
  });

  test("a sitemap entry for a file page is not asked for a trailing slash", () => {
    const site = copySite();
    edit(join(site.dist, "sitemap.xml"), (t) =>
      swap(t, "</urlset>", "<url><loc>https://docs.example.test/verify.html</loc></url></urlset>"),
    );
    expect(failing(site)).toEqual([]);
  });

  test("a docs page whose address contains 404 is not the 404 page", () => {
    const site = copySite();
    edit(join(site.dist, "sitemap.xml"), (t) =>
      swap(
        t,
        "</urlset>",
        "<url><loc>https://docs.example.test/docs/errors/404/</loc></url></urlset>",
      ),
    );
    expect(failing(site)).toEqual([]);
  });

  test("a missing dist is one failed assertion, not an exception", () => {
    const site = copySite();
    const results = assertBuild(site.root, join(site.dist, "nowhere"), {
      cname: DOMAIN,
      routes: 1,
    });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ ok: false });
    expect(results[0]?.message).toContain("the build produced nothing");
  });

  test("a long list in a message is cut", () => {
    const site = copySite();
    for (let i = 0; i < 9; i++) {
      put(
        join(site.dist, "docs", `p${i}`, "index.html"),
        "<!DOCTYPE html><title>t</title><p>no heading</p>",
      );
    }
    const message = run(site, null)[A.h1]!.message;
    expect(message).toContain("and 4 more");
    expect(message).not.toContain("/docs/p8/");
  });
});

describe("titleHoldsMarkup", () => {
  const head = (title: string) => `<!DOCTYPE html><html><head>${title}<meta name="x"></head>`;

  test("a title of text, escaped or not, is not markup", () => {
    expect(titleHoldsMarkup(`${head("<title>Install · Docs</title>")}<body></body></html>`)).toBe(
      false,
    );
    expect(titleHoldsMarkup(head("<title>Evil &lt;/title&gt;&lt;script&gt; · Docs</title>"))).toBe(
      false,
    );
    expect(titleHoldsMarkup("<title>no head at all</title><h1>x</h1>")).toBe(false);
    expect(titleHoldsMarkup("<p>no title</p>")).toBe(false);
  });

  test("a second </title> or <title> in the head is, wherever the title put the end of the head", () => {
    expect(titleHoldsMarkup(head("<title>a</title><script>x</script></title>"))).toBe(true);
    expect(titleHoldsMarkup(head("<title>a</title><title>b</title>"))).toBe(true);
    expect(titleHoldsMarkup("<title>a</title></head><b><title>b</title></head></html>")).toBe(true);
    expect(titleHoldsMarkup(head("<title>a</TITLE\n><i></title/>"))).toBe(true);
  });

  test("a <title> in the body, such as an SVG's, is not the page's title", () => {
    expect(
      titleHoldsMarkup(`${head("<title>T</title>")}<body><svg><title>icon</title></svg></body>`),
    ).toBe(false);
  });
});

describe("emptyComponents", () => {
  const tags = ["docs-header", "docs-icon"];

  test("finds registered tags with nothing inside, once each", () => {
    expect(
      emptyComponents(
        "<docs-header></docs-header><docs-header> \n</docs-header><docs-icon name='x'></docs-icon>",
        tags,
      ),
    ).toEqual(["docs-header", "docs-icon"]);
  });

  test("a rendered component, an unregistered tag, and text in a script or comment are not empty components", () => {
    expect(emptyComponents("<docs-header><nav></nav></docs-header>", tags)).toEqual([]);
    expect(emptyComponents("<other-thing></other-thing>", tags)).toEqual([]);
    expect(
      emptyComponents(
        "<script>x = '<docs-icon></docs-icon>'</script><!-- <docs-header></docs-header> -->",
        tags,
      ),
    ).toEqual([]);
    expect(emptyComponents("<docs-icon-large></docs-icon-large>", tags)).toEqual([]);
  });

  test("an attribute value holding a > does not hide the element", () => {
    expect(emptyComponents('<docs-icon title="a > b"></docs-icon>', tags)).toEqual(["docs-icon"]);
  });

  test("with no registered tag there is nothing to find", () => {
    expect(emptyComponents("<docs-header></docs-header>", [])).toEqual([]);
  });
});

describe("emptyLinks", () => {
  test("Jx's shape for a raw HTML anchor, an empty anchor and one with only white space are empty", () => {
    expect(emptyLinks("<p><a href></a>text</p>")).toEqual(["<a href>"]);
    expect(emptyLinks('<a href="/x/"></a>')).toEqual(['<a href="/x/">']);
    expect(emptyLinks('<a href="/x/">\n  <span> </span>&nbsp;</a>')).toEqual(['<a href="/x/">']);
    expect(emptyLinks('<a class="a" href="/x/"><b></b></a><a href="/y/"></a>')).toEqual([
      '<a class="a" href="/x/">',
      '<a href="/y/">',
    ]);
  });

  test("text, an image, an svg, aria-label, aria-labelledby and title each give a link something", () => {
    for (const html of [
      '<a href="/x/">text</a>',
      '<a href="/x/"><span>text</span></a>',
      '<a href="/x/"><img src="/a.png" alt=""></a>',
      '<a href="/x/"><svg viewBox="0 0 1 1"></svg></a>',
      '<a href="/x/" aria-label="Home"></a>',
      '<a href="/x/" aria-labelledby="t"></a>',
      '<a href="/x/" title="Home"></a>',
    ]) {
      expect(emptyLinks(html), html).toEqual([]);
    }
  });

  test("an empty aria-label does not count", () => {
    expect(emptyLinks('<a href="/x/" aria-label=""></a>')).toEqual([
      '<a href="/x/" aria-label="">',
    ]);
  });

  test("an anchor that is a target and not a link, scripts, comments and look-alike tags are skipped", () => {
    expect(emptyLinks('<a name="top"></a><a id="x"></a>')).toEqual([]);
    expect(emptyLinks('<script>var a = "<a href></a>";</script><!-- <a href=""></a> -->')).toEqual(
      [],
    );
    expect(emptyLinks('<abbr href="/x/"></abbr><a-b href="/x/"></a-b>')).toEqual([]);
  });

  test("an attribute value holding a > does not hide the link", () => {
    expect(emptyLinks('<a href="/x/?a>b"></a>')).toEqual(['<a href="/x/?a>b">']);
  });
});

describe("a link failure names the Markdown file of the page", () => {
  /** The message of the empty-link assertion, for a fixture whose guide page holds a raw anchor. */
  const hollow = (sources?: Record<string, string>): string => {
    const site = copySite();
    edit(guide(site), (t) => swap(t, "<p>Back", "<p><a href></a>Raw anchor. Back"));
    const results = assertBuild(site.root, site.dist, {
      cname: DOMAIN,
      routes: PAGES,
      ...(sources === undefined ? {} : { sources }),
    });
    expect(results[A.links]!.ok).toBe(false);
    return results[A.links]!.message;
  };

  // The message may go on after the entry (a hint about the usual cause), so each is matched at its start.
  test("the route, then the file it was built from, then the tag", () => {
    expect(hollow({ "/docs/": "docs/README.md", "/docs/guide/": "docs/guide/install.md" })).toMatch(
      /^links with nothing inside: \/docs\/guide\/ from docs\/guide\/install\.md \(<a href>\)(?:\.|$)/,
    );
  });

  test("a page the sources do not list, or no sources at all, is named by its route alone", () => {
    for (const message of [hollow({ "/docs/": "docs/README.md" }), hollow()]) {
      expect(message).toMatch(/^links with nothing inside: \/docs\/guide\/ \(<a href>\)(?:\.|$)/);
    }
  });

  test("the sources change nothing for a site that passes", () => {
    const site = copySite();
    const results = assertBuild(site.root, site.dist, {
      cname: DOMAIN,
      routes: PAGES,
      sources: { "/docs/guide/": "docs/guide/install.md" },
    });
    expect(results.filter((a) => !a.ok)).toEqual([]);
  });
});

describe("componentsOf", () => {
  test("lists components/*.json by tag, falls back to the file name, and reports files it cannot read", () => {
    const root = tempDir();
    mkdirSync(join(root, "components", "nested"), { recursive: true });
    writeFileSync(join(root, "components", "a-one.json"), '{ "tagName": "a-one" }');
    writeFileSync(join(root, "components", "b-two.json"), "{}");
    writeFileSync(join(root, "components", "bad.json"), "[");
    writeFileSync(join(root, "components", "notes.txt"), "x");
    writeFileSync(join(root, "components", "nested", "c-three.json"), '{ "tagName": "c-three" }');
    expect(componentsOf(root)).toEqual({
      components: [
        { file: "a-one.json", tag: "a-one" },
        { file: "b-two.json", tag: "b-two" },
      ],
      unreadable: ["components/bad.json"],
    });
  });

  test("a root without components has none", () => {
    expect(componentsOf(tempDir())).toEqual({ components: [], unreadable: [] });
  });
});
