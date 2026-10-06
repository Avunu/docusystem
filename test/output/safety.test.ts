import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { withContentSecurityPolicy } from "../../src/lib/csp.js";
import { distFiles, htmlPages, routeOfFile } from "../../src/lib/links.js";
import { safetyAssertions } from "../../src/lib/safety.js";
import { readFileSync } from "node:fs";
import { tempDir } from "../support/index.js";

const PAGE = (body: string, head = "") =>
  withContentSecurityPolicy(
    `<!DOCTYPE html><html><head><meta charset="utf8">${head}<title>T</title></head><body><docs-prose>${body}</docs-prose></body></html>`,
  );

/** Writes a site and runs the assertions on it. */
function check(site: Record<string, string>) {
  const dist = tempDir("docusystem-safety-");
  for (const [rel, text] of Object.entries(site)) {
    const file = join(dist, ...rel.split("/"));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  const files = new Set(distFiles(dist));
  const pages = htmlPages(dist).map((file) => ({
    route: routeOfFile(dist, file),
    html: readFileSync(file, "utf8"),
  }));
  return safetyAssertions(dist, files, pages);
}

describe("safetyAssertions", () => {
  test("a clean site passes all three, in order", () => {
    const results = check({
      "index.html": PAGE("<p>Hello</p>", "<script>a()</script>"),
      "docs/a/index.html": PAGE('<p><a href="b/">b</a> <img src="/content/docs/a/x.png"></p>'),
      "content/docs/a/x.png": "png",
      "content/docs/a/diagram.svg": '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>',
      "content/docs/a/guide.pdf": "pdf",
      "content/docs/a/data.json": "{}",
      "content/docs/a/config.xml": "<config/>",
    });
    expect(results.map((r) => r.ok)).toEqual([true, true, true]);
    expect(results.map((r) => r.message)).toEqual([
      "no page holds a script, an event handler, a javascript: address or an embedded page",
      "every file published from the Markdown folder is a picture, a document or data, none runs",
      "2 pages carry a Content-Security-Policy that blocks inline handlers, javascript: addresses and scripts the build did not write",
    ]);
  });

  test("a page with something that runs code names the page and the construct, and says where it comes from", () => {
    const [runs, files, policy] = check({
      "docs/a/index.html": PAGE('<img src="x" onerror="alert(1)">'),
      "docs/b/index.html": PAGE(
        '<a href="javascript:alert(1)">x</a><iframe src="https://example.com/"></iframe>',
      ),
    });
    expect(runs!.ok).toBe(false);
    expect(runs!.message).toContain('/docs/a/ (<img onerror="alert(1)">)');
    expect(runs!.message).toContain('/docs/b/ (<a href="javascript:alert(1)">, <iframe>)');
    expect(runs!.message).toMatch(/raw HTML, a link, an image or a :directive.*docusystem lint/);
    expect(files!.ok).toBe(true);
    expect(policy!.ok).toBe(true);
  });

  test("the list of pages is bounded", () => {
    const site: Record<string, string> = {};
    for (let i = 0; i < 9; i++) site[`docs/p${i}/index.html`] = PAGE("<img src=x onerror=a()>");
    const [runs] = check(site);
    expect(runs!.message).toMatch(
      /\/docs\/p0\/ .*, \/docs\/p1\/ .*, \/docs\/p2\/ .*, \/docs\/p3\/ .* and 5 more/,
    );
  });

  test.each([
    ["content/docs/evil.html", "<script>alert(1)</script>", /a \.html file/],
    ["content/docs/evil.htm", "x", /a \.htm file/],
    ["content/docs/evil.xhtml", "x", /a \.xhtml file/],
    ["content/docs/evil.js", "alert(1)", /a \.js file/],
    ["content/docs/evil.mjs", "x", /a \.mjs file/],
    ["content/docs/evil.xsl", "x", /a \.xsl file/],
    ["content/docs/evil.svgz", "x", /a \.svgz file/],
    ["content/docs/EVIL.HTML", "x", /a \.html file/],
    ["content/docs/evil.svg", '<svg onload="alert(1)"/>', /onload="alert\(1\)"/],
    ["content/docs/evil.svg", "<svg><script>1</script></svg>", /<script>/],
    [
      "content/docs/evil.xml",
      '<html xmlns="http://www.w3.org/1999/xhtml"/>',
      /XHTML or SVG namespace/,
    ],
  ])("%s is an active file", (file, text, says) => {
    const [, files] = check({ "docs/a/index.html": PAGE("<p>x</p>"), [file]: text });
    // an .html file is a page too: the page assertions are not what is asked here
    expect(files!.ok, file).toBe(false);
    expect(files!.message).toMatch(says);
    expect(files!.message).toContain(`/${file.replace("content/", "content/")}`);
  });

  test("only the Markdown folder's files are checked: the site's own scripts and pictures are not", () => {
    const results = check({
      "docs/a/index.html": PAGE("<p>x</p>"),
      "components/docs-header.js": "export {}",
      "assets/lit-html.js": "export {}",
      "favicon.svg": '<svg xmlns="http://www.w3.org/2000/svg" onload="x"/>',
    });
    expect(results[1]!.ok).toBe(true);
  });

  test("a page without a policy, with a policy that lets scripts in, or with an unnamed inline script", () => {
    const bare = '<!DOCTYPE html><html><head><meta charset="utf8"></head><body></body></html>';
    const open = PAGE("<p>x</p>").replace("script-src 'self'", "script-src 'self' 'unsafe-inline'");
    const unnamed = PAGE("<p>x</p>").replace("</body>", "<script>x()</script></body>");
    const [, , policy] = check({
      "a/index.html": bare,
      "b/index.html": open,
      "c/index.html": unnamed,
    });
    expect(policy!.ok).toBe(false);
    expect(policy!.message).toContain("/a/ (it has no Content-Security-Policy meta)");
    expect(policy!.message).toContain("/b/ (script-src allows 'unsafe-inline')");
    expect(policy!.message).toContain("/c/ (an inline script (x()...) is not named by its hash)");
  });

  test("a file of the Markdown folder that is a page is not also asked for a policy", () => {
    const [, files, policy] = check({
      "docs/a/index.html": PAGE("<p>x</p>"),
      "content/docs/evil.html": "<!DOCTYPE html><html><head></head><body></body></html>",
    });
    expect(files!.ok).toBe(false);
    expect(policy!.ok).toBe(true);
  });
});
