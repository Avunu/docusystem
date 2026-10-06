import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { lintDocs, lintMarkdown } from "../../src/lib/lint.js";
import { tempDir, writeTree } from "../support/index.js";

// The rules `unsafe-html`, `unsafe-url` and `unsafe-directive` (errors) and `html-unknown` (a warning):
// what Markdown may not carry to a page that is served from the project's own domain.
const SAFETY = /^(?:unsafe-|html-unknown)/;
const found = (source: string) =>
  lintMarkdown(source, "a.md")
    .filter((issue) => SAFETY.test(issue.rule))
    .map((issue) => `${issue.level}:${issue.rule}@${issue.line}`);
const messages = (source: string) =>
  lintMarkdown(source, "a.md")
    .filter((issue) => SAFETY.test(issue.rule))
    .map((issue) => issue.message);
const errors = (source: string) => found(source).filter((f) => f.startsWith("error:"));

describe("what is allowed", () => {
  test("text, table, picture and badge markup that GitHub shows is fine", () => {
    const source = [
      '<p align="center">',
      '  <a href="https://example.com/ci"><img src="https://img.example.com/b.svg" width="90" alt="build"></a>',
      "</p>",
      "",
      "<details><summary>More</summary>",
      "",
      'Press <kbd>Ctrl</kbd>+<kbd>C</kbd><br>and <sub>2</sub> and <abbr title="x">x</abbr>.',
      "",
      "</details>",
      "",
      "<table><tr><td align=right>1</td><td><code>x</code></td></tr></table>",
      "",
      '<picture><source srcset="a.webp 1x, b.webp 2x" type="image/webp"><img src="a.png" alt=""></picture>',
      "",
      '<a name="top"></a><a id="anchor" href="#top">top</a>',
      "",
      "[relative](guide/install.md#a) [root](/docs/) [anchor](#a) [query](?a=1) [mail](mailto:a@example.com) [tel](tel:+15551234) [web](https://example.com/a:b) [plain](http://example.com) [scheme-relative](//example.com/x) ![img](images/a.png)",
      "",
      "<https://example.com/auto> and <me@example.com> and <HTTP://EXAMPLE.COM>",
    ].join("\n");
    expect(found(source)).toEqual([]);
  });

  test("code is shown, not run: fences, code spans, indented comments and plain text with < and >", () => {
    const source = [
      "Write `<script>alert(1)</script>` or `<iframe src=x>` or `[x](javascript:alert(1))` in code.",
      "",
      "```html",
      '<script src="https://example.com/x.js"></script>',
      '<img src=x onerror="alert(1)">',
      "```",
      "",
      "~~~",
      "[x](javascript:alert(1))",
      "~~~",
      "",
      "<!-- <script>alert(1)</script> and <img onerror=alert(1)> in a comment are inert -->",
      "",
      "a < b, 3 > 2, x<3, and 10:30, a::b, https://example.com/a:b, :",
      "",
      "``<script>`` and ```<iframe>```",
    ].join("\n");
    expect(found(source)).toEqual([]);
  });

  test("reference definitions with a destination in angle brackets are not HTML", () => {
    expect(errors('[d]: <https://example.com/a b> "A title"')).toEqual([]);
  });
});

describe("raw HTML elements", () => {
  test.each([
    ["script", "<script>alert(1)</script>"],
    ["script", '<script src="https://example.com/x.js"></script>'],
    ["iframe", '<iframe src="https://example.com/"></iframe>'],
    ["frame", '<frame src="https://example.com/">'],
    ["object", '<object data="https://example.com/x.swf"></object>'],
    ["embed", '<embed src="https://example.com/x.swf">'],
    ["form", '<form action="https://example.com/"><input name="x"></form>'],
    ["input", '<input type="text" name="x">'],
    ["button", "<button>x</button>"],
    ["textarea", "<textarea>x</textarea>"],
    ["style", "<style>body{display:none}</style>"],
    ["link", '<link rel="stylesheet" href="https://example.com/x.css">'],
    ["meta", '<meta http-equiv="refresh" content="0;url=https://example.com/">'],
    ["base", '<base href="https://example.com/">'],
    ["svg", '<svg onload="alert(1)"></svg>'],
    ["math", "<math><mi>x</mi></math>"],
    ["template", "<template><b>x</b></template>"],
    ["video", '<video src="https://example.com/x.mp4"></video>'],
    ["docs-header", "<docs-header></docs-header>"],
  ])("<%s> is an error, as a block and inside a sentence", (_name, html) => {
    const asBlock = errors(`${html}\n`);
    expect(asBlock.length, html).toBeGreaterThan(0);
    expect(asBlock.every((f) => f.startsWith("error:unsafe-html@1"))).toBe(true);
    expect(errors(`Some text with ${html} in it.\n`).length, html).toBeGreaterThan(0);
  });

  test("the message says why, and what to do", () => {
    expect(messages("<script>x</script>")[0]).toBe(
      "<script> is not allowed in documentation: it runs code on the project's domain. Raw HTML may only use text, table and image elements (the ones GitHub shows too).",
    );
    expect(messages("<video src=x></video>")[0]).toMatch(
      /^<video> is not an element documentation may use\./,
    );
    expect(messages('<iframe src="x"></iframe>')[0]).toMatch(/embeds another page/);
  });

  test("a tag that is not an HTML element is a warning: Jx writes it empty, so it only vanishes", () => {
    expect(found("Run `docker run` with <name> or <version>.")).toEqual([
      "warning:html-unknown@1",
      "warning:html-unknown@1",
    ]);
    expect(found("| User-Agent | cloudflare-email-relay/<version> |\n")).toEqual([
      "warning:html-unknown@1",
    ]);
    expect(found("<my-widget></my-widget>")).toEqual(["warning:html-unknown@1"]);
    expect(messages("<name>")[0]).toMatch(/not an HTML element.*backticks/);
  });

  test("uppercase and odd spellings are read as a browser reads them", () => {
    expect(errors("<SCRIPT>alert(1)</SCRIPT>")).toEqual(["error:unsafe-html@1"]);
    expect(errors("<script\n>alert(1)</script>")).toEqual(["error:unsafe-html@1"]);
    expect(errors("<script/src=x>")).toEqual(["error:unsafe-html@1"]);
    expect(errors("<img/src/onerror=alert(1)>")).toEqual(["error:unsafe-html@1"]);
    // `/` inside an unquoted value belongs to the value: there is no handler here, as in a browser
    expect(errors("<img/src=x/onerror=alert(1)>")).toEqual([]);
  });
});

describe("attributes", () => {
  test.each([
    '<img src="x.png" onerror="alert(1)">',
    "<img src=x onerror=alert(1)>",
    '<IMG SRC=x ONERROR="alert(1)">',
    '<details open ontoggle="alert(1)"><summary>x</summary></details>',
    '<div onmouseover="alert(1)">x</div>',
    '<a href="https://example.com" onclick = "alert(1)">x</a>',
    "<p onclick=\"alert('a>b')\">x</p>",
    '<img src="x.png" style="position:fixed;inset:0">',
    '<div style="width:100%">x</div>',
    '<a href="https://example.com" ping="https://example.com/p">x</a>',
    '<div is="docs-header">x</div>',
  ])("%s is an error", (html) => {
    expect(errors(html).length, html).toBeGreaterThan(0);
  });

  test("the message names the attribute and the element", () => {
    expect(messages('<img src="x.png" onerror="alert(1)">')).toEqual([
      "The onerror attribute on <img> is an event handler: it runs code on the project's domain. Remove it.",
    ]);
    expect(messages('<p style="color:red">x</p>')[0]).toMatch(
      /^The style attribute on <p> is not allowed/,
    );
  });

  test("ordinary attributes are fine", () => {
    expect(
      found(
        '<img src="a.png" alt="a" width="10" height="10" loading="lazy" class="x" id="y" data-x="1" title="t">',
      ),
    ).toEqual([]);
  });

  test("a tag that spans lines is reported on the line it starts", () => {
    expect(errors('text\n\n<img\n  src="x.png"\n  alt="x"\n  onerror="alert(1)">')).toEqual([
      "error:unsafe-html@3",
    ]);
    expect(errors('Some <a\nhref="javascript:alert(1)">\nlink</a>')).toEqual([
      "error:unsafe-html@1",
    ]);
  });
});

describe("addresses in raw HTML and in Markdown", () => {
  const bad = [
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    " javascript:alert(1)",
    "\tjavascript:alert(1)",
    "java\tscript:alert(1)",
    "java&#9;script:alert(1)",
    "java&Tab;script:alert(1)",
    "java&NewLine;script:alert(1)",
    "&#106;avascript:alert(1)",
    "&#106avascript:alert(1)",
    "&#x6A;avascript:alert(1)",
    "&#0000106;avascript:alert(1)",
    "javascript&colon;alert(1)",
    "javascript&#58;alert(1)",
    "vbscript:msgbox(1)",
    "data:text/html,<script>alert(1)</script>",
    "data:image/svg+xml;base64,PHN2Zz4=",
    "data:image/png;base64,AAAA",
    "blob:https://example.com/x",
    "file:///etc/passwd",
    "ftp://example.com/x",
    "view-source:https://example.com",
    "java&unknown;script:alert(1)",
  ];

  test.each(bad)("an <a href> to %s is an error", (address) => {
    expect(errors(`<a href="${address}">x</a>`).length, address).toBeGreaterThan(0);
    expect(errors(`<img src='${address}'>`).length, address).toBeGreaterThan(0);
  });

  test.each(bad.filter((a) => !/[\s<>]/.test(a.trim()) || a.startsWith("data")))(
    "a Markdown link and image to %s is an error",
    (address) => {
      const spaced = /\s/.test(address) ? `<${address}>` : address;
      expect(errors(`[x](${spaced})`).length, address).toBeGreaterThan(0);
      expect(errors(`![x](${spaced})`).length, address).toBeGreaterThan(0);
    },
  );

  test.each([
    "https://example.com/a?b=c&d=e",
    "http://example.com",
    "mailto:a@example.com",
    "tel:+15551234",
    "guide/install.md",
    "../README.md#a",
    "/docs/",
    "#section",
    "?q=1",
    "",
    "a/b:c",
    "//example.com/x",
    "page.html?next=javascript:alert(1)",
    "page&amp;x.html",
  ])("%j is fine", (address) => {
    expect(errors(`<a href="${address}">x</a>`)).toEqual([]);
    expect(errors(`[x](<${address}>)`)).toEqual([]);
  });

  test("srcset is read candidate by candidate", () => {
    expect(errors('<img srcset="a.png 1x, javascript:alert(1) 2x">').length).toBeGreaterThan(0);
    expect(errors('<img srcset="a.png 1x, https://example.com/b.png 2x">')).toEqual([]);
  });

  test("autolinks", () => {
    expect(errors("<javascript:alert(1)>")).toEqual(["error:unsafe-url@1"]);
    expect(errors("<JAVASCRIPT:alert(1)>")).toEqual(["error:unsafe-url@1"]);
    expect(errors("<data:text/html,x>")).toEqual(["error:unsafe-url@1"]);
    expect(errors("<https://example.com/a> <mailto:a@example.com>")).toEqual([]);
  });

  test("a destination may start on the line after its parenthesis", () => {
    expect(errors("[x](\njavascript:alert(1))")).toEqual(["error:unsafe-url@2"]);
    expect(errors("[x](\n  <javascript:alert(1)>)")).toEqual(["error:unsafe-url@2"]);
  });

  test("backslash escapes and references in a destination are read as CommonMark reads them", () => {
    expect(errors("[x](javascript&#58;alert\\(1\\))")).toEqual(["error:unsafe-url@1"]);
    expect(errors("[x](java\\script:alert(1))")).toEqual([]); // a backslash that escapes nothing stays: not a scheme
  });

  test("the message shows the address, and why", () => {
    expect(messages("[x](javascript:alert(1))")).toEqual([
      'The link is "javascript:alert(1)" (javascript:): only http, https, mailto, tel and relative addresses may be linked, because a javascript: or data: address runs code or opens a page on the project\'s own domain.',
    ]);
    expect(messages('<a href="data:text/html,x">y</a>')[0]).toMatch(
      /^The href of <a> is "data:text\/html,x" \(data:\)/,
    );
    expect(messages("![x](javascript:alert(1))")[0]).toMatch(/^The image is /);
  });

  test("a link inside a link's text and an image link are both read", () => {
    expect(errors("[![a](b.png)](javascript:alert(1))")).toEqual(["error:unsafe-url@1"]);
    expect(errors("[![a](javascript:alert(1))](https://example.com)")).toEqual([
      "error:unsafe-url@1",
    ]);
  });
});

describe("how the Markdown is read", () => {
  test("an HTML block is read in full: backticks and backslashes mean nothing in it", () => {
    expect(errors("<div>\n`<script>alert(1)</script>`\n</div>")).toEqual(["error:unsafe-html@2"]);
    expect(errors("<div>\\<img src=x onerror=alert(1)></div>")).toEqual(["error:unsafe-html@1"]);
    expect(errors("<div>\n\\<iframe src=x>\n</div>")).toEqual(["error:unsafe-html@2"]);
  });

  test("an HTML block in a quote or a list item is an HTML block", () => {
    expect(errors("> <div>\n> `<script>alert(1)</script>`")).toEqual(["error:unsafe-html@2"]);
    expect(errors("- <div>\n  `<script>alert(1)</script>`")).toEqual(["error:unsafe-html@2"]);
    expect(errors("> <iframe src=x></iframe>")).toEqual(["error:unsafe-html@1"]);
    expect(errors("1. <script>alert(1)</script>")).toEqual(["error:unsafe-html@1"]);
  });

  test("a comment that is not closed in its paragraph is text, and hides nothing after it", () => {
    expect(errors("text <!-- <img src=x onerror=alert(1)>")).toEqual(["error:unsafe-html@1"]);
    expect(errors("text <? <script>alert(1)</script>")).toEqual(["error:unsafe-html@1"]);
    expect(errors("text <![CDATA[ <script>alert(1)</script>")).toEqual(["error:unsafe-html@1"]);
    expect(errors("text <!x and <script>alert(1)</script>")).toEqual([]); // `<!x and <script>` is a declaration: no element
    expect(errors("text <!x and <b onclick=alert(1)")).toEqual([]); // and this tag is not closed
    expect(errors("text <!-- <script> --> <script>alert(2)</script>")).toEqual([
      "error:unsafe-html@1",
    ]);
  });

  test("a closed comment hides only itself, also across lines", () => {
    expect(errors("<!--\n<script>alert(1)</script>\n-->\n\ntext")).toEqual([]);
    // the comment block ends with the line that has the `-->`; the line after it is a block of its own
    expect(errors("<!--\n<script>alert(1)</script>\n-->\n<script>alert(2)</script>")).toEqual([
      "error:unsafe-html@4",
    ]);
  });

  test("the end of a raw block lets the next one start", () => {
    expect(errors("<pre>\n<b>x</b>\n</pre>\n\n<script>alert(1)</script>")).toEqual([
      "error:unsafe-html@5",
    ]);
  });

  test("a backtick inside a tag does not hide the rest of the tag", () => {
    expect(errors('<a title="`" href="javascript:alert(1)">x</a> and `code`')).toEqual([
      "error:unsafe-html@1",
    ]);
  });

  test("an unclosed tag at the end of the text is dropped, as a parser drops it", () => {
    expect(errors("text <img src=x onerror=alert(1)")).toEqual([]);
  });

  test("the front matter is not read, and line numbers count it", () => {
    const docs = writeTree(tempDir(), {
      "a.md":
        "---\ntitle: 'A <script>'\ndescription: <iframe>\n---\n\nText\n\n<script>alert(1)</script>\n",
    });
    expect(lintDocs(docs).map((i) => `${i.rule}@${i.line}`)).toEqual(["unsafe-html@8"]);
    expect(lintDocs(docs)[0]!.file).toBe("a.md");
    expect(join(docs, "a.md")).toContain("a.md");
  });

  test("a file with hundreds of findings lists the first fifty and counts the rest", () => {
    const source = Array.from({ length: 80 }, () => "<script>alert(1)</script>").join("\n\n");
    const issues = lintMarkdown(source, "a.md").filter((i) => i.rule === "unsafe-html");
    expect(issues).toHaveLength(51);
    expect(issues.at(-1)!.message).toBe("30 more unsafe constructs in this file are not listed.");
  });

  test("a paragraph with so many unclosed tags that it cannot be read is an error, not a hang", () => {
    const issues = lintMarkdown("<a ".repeat(50_000), "a.md").filter(
      (i) => i.rule === "unsafe-html",
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toMatch(/cannot be checked/);
  });

  test("hostile lines are read in time proportional to their length", () => {
    const inputs: Record<string, string> = {
      "unclosed tags": "<a ".repeat(50_000),
      "unclosed quotes": "<a b='".repeat(20_000),
      "tags with one quote too many": `${"<a b='x'>".repeat(5_000)}<a b='`,
      "unclosed comments": `<!-- ${"<!-- ".repeat(20_000)}`,
      "unclosed destinations": "[a](".repeat(20_000),
      "unclosed directives": ":a[".repeat(20_000),
      "unclosed directive attributes": ":a{".repeat(20_000),
      "backticks of every length": "` `` ``` ````".repeat(5_000),
      "less-than signs": "<".repeat(100_000),
      "autolink starts": "<a:".repeat(30_000),
      "many short paragraphs": "<a\n\n".repeat(30_000),
    };
    // These take well under a second each on a development machine. A reader that re-scans the rest of
    // the text at every failed tag, quote or bracket would need minutes for them, so the bounds are wide:
    // a loaded CI machine is many times slower than a laptop, and this is a test for the shape of the
    // cost, not for the speed of the machine.
    for (const [name, source] of Object.entries(inputs)) {
      const started = Date.now();
      lintMarkdown(source, "a.md");
      expect(Date.now() - started, name).toBeLessThan(15_000);
    }
  }, 180_000);
});

describe("directives", () => {
  test("a directive that makes a refused element is an error", () => {
    expect(errors(":script[alert(1)]")).toEqual(["error:unsafe-directive@1"]);
    expect(errors('::iframe{src="https://example.com/"}')).toEqual(["error:unsafe-directive@1"]);
    expect(errors(':::form{action="https://example.com/"}\ntext\n:::')).toEqual([
      "error:unsafe-directive@1",
    ]);
    expect(messages(":script[alert(1)]")[0]).toMatch(
      /^The directive :script makes a <script> element/,
    );
  });

  test("its attributes follow the policy for raw HTML", () => {
    expect(errors(':a[x]{href="javascript:alert(1)"}')).toEqual(["error:unsafe-directive@1"]);
    expect(errors(":span[x]{onclick=alert(1)}")).toEqual(["error:unsafe-directive@1"]);
    expect(errors(':div[x]{style="position:fixed"}')).toEqual(["error:unsafe-directive@1"]);
  });

  test("and the attributes that write markup or Jx internals are refused", () => {
    expect(errors('::div{innerHTML="<b>x</b>"}')).toContain("error:unsafe-directive@1");
    expect(errors('::div{textContent="x"}')).toEqual(["error:unsafe-directive@1"]);
    expect(errors('::div{$ref="https://example.com/x.json"}')).toEqual([
      "error:unsafe-directive@1",
    ]);
    expect(errors('::div{$prototype="Function" body="x"}')).toEqual(["error:unsafe-directive@1"]);
  });

  test("an ordinary directive, a time, a double colon and an emoji code are not findings", () => {
    expect(errors(':a[x]{href="https://example.com"}')).toEqual([]);
    expect(errors(":::note\nText\n:::")).toEqual([]);
    expect(errors("At 10:30 see a::b and :smile: and std::vector and http://x.example")).toEqual(
      [],
    );
  });

  test("prose that happens to hold a directive name of a refused element is told so", () => {
    expect(messages("the :link pseudo-class")[0]).toMatch(
      /If this is not a directive, put it in backticks/,
    );
    expect(errors("the `:link` pseudo-class")).toEqual([]);
  });
});
