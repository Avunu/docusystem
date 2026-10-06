import { describe, expect, test } from "vitest";
import {
  type Tag,
  decodeReferences,
  extensionOf,
  pageHazards,
  readAt,
  svgHazards,
  tagProblems,
  tokens,
  unsafeUrl,
  xmlHazards,
} from "../../src/lib/html-policy.js";

const tags = (html: string): Tag[] => tokens(html).filter((t): t is Tag => t.kind === "tag");
const names = (html: string): string[] => tags(html).map((t) => `${t.closing ? "/" : ""}${t.name}`);

describe("decodeReferences", () => {
  test("numeric references with or without the semicolon, decimal and hex", () => {
    expect(decodeReferences("&#106;avascript&#58;")).toBe("javascript:");
    expect(decodeReferences("&#106avascript")).toBe("javascript");
    expect(decodeReferences("&#x6A;&#X61;&#x0000076;a")).toBe("java");
    expect(decodeReferences("&#0000106;")).toBe("j");
  });

  test("the named references that matter in an address, and no others", () => {
    expect(decodeReferences("a&colon;b&Tab;c&NewLine;d&amp;e&lt;&gt;&quot;&apos;")).toBe(
      "a:b\tc\nd&e<>\"'",
    );
    expect(decodeReferences("&hellip; &unknown;")).toBe("&hellip; &unknown;");
  });

  test("a reference is decoded once", () => {
    expect(decodeReferences("&amp;#106;")).toBe("&#106;");
  });

  test("a NUL, a surrogate and a code point past the end of Unicode are U+FFFD", () => {
    expect(decodeReferences("&#0;&#xD800;&#x110000;")).toBe("\ufffd\ufffd\ufffd");
  });
});

describe("unsafeUrl", () => {
  test.each([
    ["https://example.com/a?b=c#d", null],
    ["http://example.com", null],
    ["HTTPS://EXAMPLE.COM", null],
    ["mailto:a@example.com", null],
    ["tel:+1555", null],
    ["", null],
    ["#top", null],
    ["?q", null],
    ["a/b:c", null],
    ["./a:b", null],
    ["../x", null],
    ["//example.com", null],
    ["C:\\dir", "c:"],
    ["javascript:alert(1)", "javascript:"],
    ["JAVASCRIPT:alert(1)", "javascript:"],
    ["  \t\njavascript:alert(1)", "javascript:"],
    ["\u0001javascript:alert(1)", "javascript:"],
    ["jav\nascript:alert(1)", "javascript:"],
    ["jav&#x0A;ascript:alert(1)", "javascript:"],
    ["jav&Tab;ascript&colon;alert(1)", "javascript:"],
    ["vbscript:x", "vbscript:"],
    ["data:text/html;base64,PHNjcmlwdD4=", "data:"],
    ["blob:https://example.com/uuid", "blob:"],
    ["file:///etc/passwd", "file:"],
    ["ftp://example.com", "ftp:"],
    ["java&weird;script:alert(1)", "an address with a reference that hides its scheme"],
    ["page&amp;x.html", null],
    ["x&amp;y:z", null], // a & cannot be in a scheme: a relative path
    ["1javascript:alert(1)", null], // a scheme must start with a letter: this is a relative path
    ["java script:alert(1)", null], // and cannot hold a space: so is this
    ["\u00a0javascript:alert(1)", null], // U+00A0 is not stripped by the URL parser, so no scheme
  ])("%j -> %j", (address, why) => {
    expect(unsafeUrl(address)).toBe(why);
  });

  test("embedded pictures are allowed only when asked for, and only rasters", () => {
    const png = "data:image/png;base64,iVBORw0KGgo=";
    expect(unsafeUrl(png)).toBe("data:");
    expect(unsafeUrl(png, { dataImages: true })).toBeNull();
    expect(unsafeUrl("data:image/jpeg;base64,/9j/4AAQ", { dataImages: true })).toBeNull();
    expect(unsafeUrl("data:image/svg+xml;base64,PHN2Zz4=", { dataImages: true })).toBe("data:");
    expect(unsafeUrl("data:text/html;base64,PHNjcmlwdD4=", { dataImages: true })).toBe("data:");
    expect(unsafeUrl("data:image/png,not-base64", { dataImages: true })).toBe("data:");
  });
});

describe("tokens: tags the way an HTML tokenizer finds them", () => {
  test("names and attributes: quotes, unquoted values, no value, upper case, repeats", () => {
    const [tag] = tags(`<IMG SRC="a.png" alt='it''s' width=10 hidden data-x = "1" Loading=lazy>`);
    expect(tag).toMatchObject({ name: "img", closing: false, start: 0 });
    expect(tag!.attributes).toEqual([
      { name: "src", value: "a.png" },
      { name: "alt", value: "it" },
      { name: "'s'", value: "" },
      { name: "width", value: "10" },
      { name: "hidden", value: "" },
      { name: "data-x", value: "1" },
      { name: "loading", value: "lazy" },
    ]);
  });

  test("a > inside a quoted value does not end the tag", () => {
    const [tag] = tags('<a title="a > b" href=x>');
    expect(tag!.attributes).toEqual([
      { name: "title", value: "a > b" },
      { name: "href", value: "x" },
    ]);
    expect(tag!.end).toBe('<a title="a > b" href=x>'.length);
  });

  test("slashes: between attributes they separate, in an unquoted value they belong to it", () => {
    expect(tags("<img/src/onerror=x>")[0]!.attributes.map((a) => a.name)).toEqual([
      "src",
      "onerror",
    ]);
    expect(tags("<img/src=x/onerror=y>")[0]!.attributes).toEqual([
      { name: "src", value: "x/onerror=y" },
    ]);
    expect(tags("<br/>")[0]).toMatchObject({ name: "br", attributes: [] });
    expect(tags("<a href=x/>")[0]!.attributes).toEqual([{ name: "href", value: "x/" }]);
  });

  test("an equals sign starts an attribute name, and spaces around = are allowed", () => {
    expect(tags("<a =x y = z>")[0]!.attributes).toEqual([
      { name: "=x", value: "" },
      { name: "y", value: "z" },
    ]);
  });

  test("white space of every kind separates", () => {
    expect(tags("<a\thref=x\nonclick=y\fz\r>")[0]!.attributes.map((a) => a.name)).toEqual([
      "href",
      "onclick",
      "z",
    ]);
  });

  test("end tags are tokens; an end tag with no name, and text with < in it, are not", () => {
    expect(names("<b>x</b> a < b <3 </> </ x <")).toEqual(["b", "/b"]);
    expect(names("a<b>c")).toEqual(["b"]);
  });

  test("comments, doctypes, processing instructions and declarations hide what is in them", () => {
    expect(
      names(
        "<!-- <script> --><b><!--> <i><!---> <u><!-- a --!> <s><!DOCTYPE html><?php <em> ?><![CDATA[ <q> ]]>",
      ),
    ).toEqual(["b", "i", "u", "s"]);
  });

  test("an unclosed comment hides the rest of an HTML text, and only its own text in Markdown", () => {
    expect(names("<b><!-- <script>")).toEqual(["b"]);
    expect(tokens("<b><!-- <i>", { inline: true }).map((t) => (t as Tag).name)).toEqual(["b", "i"]);
  });

  test("the content of a raw text element is not markup; its offsets are on the start tag", () => {
    const html = "<p><script>if (a<b && c>d) { x = '</div>' }</script><b>";
    expect(names(html)).toEqual(["p", "script", "/script", "b"]);
    const script = tags(html)[1]!;
    expect(html.slice(script.body!.start, script.body!.end)).toBe(
      "if (a<b && c>d) { x = '</div>' }",
    );
    expect(
      names("<style>a > b {}</style><title>a <b> c</title><textarea><i></textarea><x>"),
    ).toEqual(["style", "/style", "title", "/title", "textarea", "/textarea", "x"]);
  });

  test("a raw text element ends at its own end tag, in any case, followed by a space, a slash or >", () => {
    expect(names("<script></SCRIPT ><b>")).toEqual(["script", "/script", "b"]);
    expect(names("<script></scripted><b></script/><i>")).toEqual(["script", "/script", "i"]);
    expect(names("<script><b>")).toEqual(["script"]);
  });

  test("plaintext takes the rest of the text", () => {
    expect(names("<plaintext><b>")).toEqual(["plaintext"]);
  });

  test("a tag that the text ends inside of is dropped", () => {
    expect(names('<b>x<i onclick="y')).toEqual(["b"]);
    expect(names("<b>x<i onclick=y")).toEqual(["b"]);
    expect(names("<b>x<i")).toEqual(["b"]);
  });

  test("in Markdown, <scheme:address> is an autolink and <name@host> is only text", () => {
    const found = tokens("<https://example.com/a> <javascript:alert(1)> <me@example.com> <b>", {
      autolinks: true,
    });
    expect(found.map((t) => (t.kind === "autolink" ? t.url : t.name))).toEqual([
      "https://example.com/a",
      "javascript:alert(1)",
      "b",
    ]);
    // as HTML it is a tag with an odd name
    expect(names("<https://example.com/a>")).toEqual(["https:"]);
  });

  test("in Markdown, a tag that is not closed is text", () => {
    expect(readAt("<img src=x", 0, { inline: true })).toMatchObject({
      end: 1,
      next: 1,
      scanned: 10,
    });
    expect(readAt("<img src=x", 0)).toMatchObject({ end: 10, next: 10 });
    expect(readAt("a < b", 2, { inline: true })).toEqual({ end: 3, next: 3 });
  });
});

describe("tagProblems", () => {
  const problems = (html: string) =>
    tags(html)
      .flatMap(tagProblems)
      .map((p) => `${p.level}:${p.rule}`);

  test("end tags and allowed elements are fine", () => {
    expect(problems("</script></iframe><p></p><br/>")).toEqual([]);
  });

  test("a refused element is one error, whatever its attributes", () => {
    expect(problems('<iframe src="javascript:x" onload="y">')).toEqual(["error:unsafe-html"]);
  });

  test("an element that is not an element is a warning, a known or the site's own is an error", () => {
    expect(problems("<foo> <bar-baz>")).toEqual(["warning:html-unknown", "warning:html-unknown"]);
    expect(problems("<marquee> <canvas> <docs-header> <project-switcher> <theme-toggle>")).toEqual([
      "error:unsafe-html",
      "error:unsafe-html",
      "error:unsafe-html",
      "error:unsafe-html",
      "error:unsafe-html",
    ]);
  });
});

describe("pageHazards", () => {
  const page = (body: string, head = "") =>
    `<!DOCTYPE html><html><head><meta charset="utf8">${head}<title>T</title></head><body><docs-header><nav><a href="/">x</a><button type="button" popovertarget="d">m</button><input placeholder="Search"></nav></docs-header><main><docs-prose>${body}</docs-prose><footer>f</footer></main></body></html>`;

  test("a page of the site, and prose that the site makes, has none", () => {
    const head =
      '<script>(function(){var s=1})()</script><style>a>b{color:red}</style><link rel="icon" href="/f.svg"><script type="importmap">{"imports":{}}</script><script type="module" src="/c.js"></script><meta name="description" content="javascript: the good parts">';
    const body =
      '<h2 id="x">T</h2><p><a href="guide/">g</a> <a href="https://example.com/?a=1&amp;b=2">e</a> <a href="mailto:a@example.com">m</a></p><docs-callout data-alert="note"><docs-icon><svg viewBox="0 0 24 24"><path d="M1 1"></path></svg></docs-icon><p>x</p></docs-callout><pre><code class="language-js">a &lt; b</code></pre><picture><source srcset="/a.avif 1x, /b.avif 2x"><img src="/c.png" alt="javascript: a title"></picture>';
    expect(pageHazards(page(body, head))).toEqual([]);
  });

  test("event handlers anywhere, whatever the element and the case", () => {
    expect(pageHazards(page('<img src="x" onerror="alert(&#39;a&#39;)">'))).toEqual([
      `<img onerror="alert('a')">`,
    ]);
    expect(pageHazards(page('<details open ONTOGGLE="x"></details>'))).toEqual([
      '<details ontoggle="x">',
    ]);
    expect(pageHazards(page("<svg onload=alert(1)></svg>"))).toEqual(['<svg onload="alert(1)">']);
    expect(pageHazards(page("", '<meta name="x" onclick="y">'))).toEqual(['<meta onclick="y">']);
    expect(pageHazards(page("<span data-onclick=1 on=3>x</span>"))).toEqual([]);
  });

  test("addresses that run code or load a page, in every attribute that holds an address", () => {
    expect(pageHazards(page('<a href="javascript:alert(1)">x</a>'))).toEqual([
      '<a href="javascript:alert(1)">',
    ]);
    expect(pageHazards(page('<a href="  JaVa&#x09;Script:alert(1)">x</a>'))).toEqual([
      '<a href="JaVa Script:alert(1)">',
    ]);
    expect(pageHazards(page('<img src="data:image/svg+xml;base64,PHN2Zz4=">'))).toEqual([
      '<img src="data:image/svg+xml;base64,PHN2Zz4=">',
    ]);
    expect(pageHazards(page('<img srcset="/a.png 1x, javascript:x 2x">'))).toHaveLength(1);
    expect(
      pageHazards(page('<svg><a xlink:href="javascript:x"><text>t</text></a></svg>')),
    ).toHaveLength(1);
    expect(
      pageHazards(page('<svg><set attributeName="href" to="javascript:alert(1)"/></svg>')),
    ).toHaveLength(1);
    expect(pageHazards(page("", '<link rel="x" href="javascript:y">'))).toHaveLength(1);
  });

  test("elements that no page holds, and elements that the page content does not hold", () => {
    expect(pageHazards(page('<iframe src="https://example.com/"></iframe>'))).toEqual(["<iframe>"]);
    expect(pageHazards(page("<object></object><embed><form></form><base>"))).toEqual([
      "<object>",
      "<embed>",
      "<form>",
      "<base>",
    ]);
    expect(pageHazards(page("<script>alert(1)</script>"))).toEqual([
      "<script> in the page content",
    ]);
    expect(
      pageHazards(page('<style>x{}</style><link rel="stylesheet" href="/a.css"><meta name="x">')),
    ).toEqual([
      "<style> in the page content",
      "<link> in the page content",
      "<meta> in the page content",
    ]);
    expect(pageHazards(page("<math><mi>x</mi></math><template></template>"))).toEqual([
      "<math> in the page content",
      "<template> in the page content",
    ]);
    // the same elements in the head are the site's own
    expect(
      pageHazards(
        page("", "<script>1</script><style>a{}</style><link rel=icon href=/f><meta name=x>"),
      ),
    ).toEqual([]);
  });

  test("a style attribute is refused in the page content only", () => {
    expect(pageHazards(page('<div style="position:fixed">x</div>'))).toEqual([
      '<div style="position:fixed">',
    ]);
    expect(pageHazards(page("", ""))).toEqual([]);
    expect(pageHazards(`<html><body><nav style="display:none"></nav></body></html>`)).toEqual([]);
  });

  test("a nested or repeated docs-prose does not move the content boundary", () => {
    const html = `<docs-prose><docs-prose></docs-prose><script>1</script></docs-prose><docs-prose>`;
    expect(pageHazards(html)).toEqual(["<script> in the page content"]);
    expect(pageHazards("</docs-prose></docs-prose><script>1</script>")).toEqual([]);
  });

  test("a meta cannot redirect the page, set a cookie or switch the stylesheet; the harmless ones are left alone", () => {
    for (const equiv of ["x-ua-compatible", "content-type", "content-language"]) {
      expect(pageHazards(page("", `<meta http-equiv="${equiv}" content="x">`)), equiv).toEqual([]);
    }
    expect(pageHazards(page("", '<meta http-equiv=" Default-Style " content="x">'))).toEqual([
      '<meta http-equiv="default-style">',
    ]);
  });

  test("a meta that is not the site's policy cannot redirect or reconfigure the page", () => {
    expect(
      pageHazards(page("", '<meta http-equiv="refresh" content="0;url=https://example.com">')),
    ).toEqual(['<meta http-equiv="refresh">']);
    expect(
      pageHazards(
        page("", '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'">'),
      ),
    ).toEqual([]);
    expect(pageHazards(page("", '<meta http-equiv="set-cookie" content="a=b">'))).toHaveLength(1);
  });

  test("what is inside a script or a style is not read as markup", () => {
    expect(pageHazards(page("", "<script>var a = '<iframe onload=x>'</script>"))).toEqual([]);
  });
});

describe("files published from the Markdown folder", () => {
  test("extensions", () => {
    expect(extensionOf("content/docs/a/Evil.HTML")).toBe("html");
    expect(extensionOf("content/docs/a.tar.gz")).toBe("gz");
    expect(extensionOf("content/docs/.hidden")).toBe("");
    expect(extensionOf("content/docs.d/noext")).toBe("");
  });

  test("a plain SVG picture has no hazard", () => {
    expect(
      svgHazards(
        '<?xml version="1.0"?><!-- c --><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><style>.a{fill:red}</style><title>t</title><defs><linearGradient id="g"/></defs><a href="https://example.com"><rect class="a" width="1" height="1"/></a><image href="data:image/png;base64,iVBORw0KGgo="/><use xlink:href="#g"/></svg>',
      ),
    ).toEqual([]);
  });

  test.each([
    ['<svg onload="alert(1)"/>', 'onload="alert(1)"'],
    ["<svg><script>alert(1)</script></svg>", "<script>"],
    ["<svg><foreignObject><iframe/></foreignObject></svg>", "<foreignobject>"],
    ['<svg><a href="javascript:alert(1)"><rect/></a></svg>', 'href="javascript:alert(1)"'],
    [
      '<svg><a xlink:href="&#106;avascript:alert(1)"><rect/></a></svg>',
      'xlink:href="&#106;avascript:alert(1)"',
    ],
    [
      '<svg><image href="data:image/svg+xml;base64,PHN2Zz4="/></svg>',
      'href="data:image/svg+xml;base64,PHN2Zz4="',
    ],
    ['<svg><set attributeName="href" to="javascript:alert(1)"/></svg>', 'to="javascript:alert(1)"'],
    [
      '<svg><animate attributeName="href" values="javascript:alert(1)"/></svg>',
      'values="javascript:alert(1)"',
    ],
    [
      '<!DOCTYPE svg [<!ENTITY x "javascript:">]><svg><a href="&x;alert(1)"/></svg>',
      "an entity declaration",
    ],
    ['<?xml-stylesheet href="x.xsl"?><svg/>', "an xml-stylesheet instruction"],
    [
      '<html xmlns="http://www.w3.org/1999/xhtml"><body onload="x"></body></html>',
      "a root element <html> instead of <svg>",
    ],
  ])("%s is active (%s)", (svg, why) => {
    expect(svgHazards(svg)).toContain(why);
  });

  test("XML is active when it says it is XHTML or SVG, or names a stylesheet", () => {
    expect(xmlHazards('<?xml version="1.0"?><config><a b="c"/></config>')).toEqual([]);
    expect(
      xmlHazards('<html xmlns="http://www.w3.org/1999/xhtml"><script>1</script></html>'),
    ).toEqual(["an XHTML or SVG namespace"]);
    expect(xmlHazards('<?xml-stylesheet type="text/xsl" href="x.xsl"?><a/>')).toEqual([
      "an xml-stylesheet instruction",
    ]);
  });
});
