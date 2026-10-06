// inert.ts: what keeps a `${` of a page, a title or a name from reaching Jx, which evaluates every
// string that holds one with `new Function`. The integration tests (test/integration/jx-expressions*.ts)
// prove it with the real Jx; these pin the helpers that do it, and the spellings they must catch.
import { describe, expect, test } from "vitest";
import {
  expressionsIn,
  hasExpression,
  INERT,
  neutralizeData,
  neutralizeSource,
  neutralizeStrings,
  restoreData,
  restoreText,
} from "../../src/lib/inert.js";

const ZWSP = String.fromCodePoint(0x200b);

/** Every way that Markdown, HTML or YAML spells `$` followed by `{` (the spellings the module lists). */
const SPELLINGS = [
  "${",
  "$\\{",
  "\\$\\{",
  "&#36;{",
  "&#036;{",
  "&#x24;{",
  "&#X24;{",
  "&dollar;{",
  "&dollar{",
  "${".replace("$", "&#36;").replace("{", "&#123;"),
  "&#36;&#x7B;",
  "&#x24;&#x7b;",
  "&dollar;&lbrace;",
  "&dollar;&lcub;",
  "$&lbrace;",
  "&#36;&#123",
];

describe("neutralizeSource: every spelling of `${` becomes $, a zero-width space and {", () => {
  test.each(SPELLINGS)("%s", (spelling) => {
    const out = neutralizeSource(`before ${spelling}expression} after\n`);
    expect(out).toBe(`before ${INERT}expression} after\n`);
    expect(out).not.toContain("${");
    expect(expressionsIn(out)).toEqual([]);
  });

  test("the marker is `$`, a zero-width space and `{`, the spelling Jx's own parser uses", () => {
    expect(INERT).toBe(`$${ZWSP}{`);
    expect(INERT).toHaveLength(3);
  });

  test("the same string comes back when there is nothing to write (a `$` or `{` alone is not one)", () => {
    for (const text of [
      "plain\n",
      "price: $5 and {braces}\n",
      "a $ { b\n",
      "$\n{\n",
      "&amp; &#36; and &lt;{\n",
      "",
    ]) {
      expect(neutralizeSource(text)).toBe(text);
    }
  });

  test("line endings and every other line are kept, a mixed file included", () => {
    const source = "a ${x}\r\nb\nc ${y}\r\n";
    expect(neutralizeSource(source)).toBe(`a ${INERT}x}\r\nb\nc ${INERT}y}\r\n`);
  });

  test("it is idempotent, and a second pass finds nothing", () => {
    for (const spelling of SPELLINGS) {
      const once = neutralizeSource(`x ${spelling}a} y`);
      expect(neutralizeSource(once)).toBe(once);
    }
  });

  test("in code too: a line scanner cannot know what CommonMark reads as code in every container", () => {
    const source = "```bash\necho ${HOME}\n```\n\nInline `${PORT}`.\n";
    const out = neutralizeSource(source);
    expect(out).toBe(`\`\`\`bash\necho ${INERT}HOME}\n\`\`\`\n\nInline \`${INERT}PORT}\`.\n`);
  });

  test("YAML's own escapes count in the frontmatter, and only there", () => {
    const body = "# T\n\n\\x24\\x7B and \\u0024\\u007B stay as written.\n";
    const source = `---\ntitle: "a \\x24\\x7Bx} \\u0024\\u007Bx} \\U00000024\\U0000007Bx}"\n---\n\n${body}`;
    const out = neutralizeSource(source);
    expect(out).toBe(`---\ntitle: "a ${INERT}x} ${INERT}x} ${INERT}x}"\n---\n\n${body}`);
  });

  test("a frontmatter that follows a byte order mark, or has trailing spaces, is still frontmatter", () => {
    const bom = '﻿---\ntitle: "\\x24\\x7Bx}"\n---\n\nbody\n';
    expect(neutralizeSource(bom)).toContain(`${INERT}x}`);
    const spaced = '---   \ntitle: "\\u0024\\u007Bx}"\n---   \n\nbody\n';
    expect(neutralizeSource(spaced)).toContain(`${INERT}x}`);
  });

  test("a frontmatter line that looks like a fence does not hide the page that follows", () => {
    const source = `---\ntitle: T\nnote: |\n  \`\`\`\n---\n\n[a](https://example.com/\${x})\n`;
    expect(neutralizeSource(source)).toContain(`https://example.com/${INERT}x})`);
  });
});

describe("neutralizeData and neutralizeStrings: the strings of the generated data", () => {
  test("a string with `${` is written inert, one without is returned as it is", () => {
    expect(neutralizeData("Title ${a}")).toBe(`Title ${INERT}a}`);
    expect(neutralizeData("Title")).toBe("Title");
    expect(hasExpression("a ${b}")).toBe(true);
    expect(hasExpression("a $ {b}")).toBe(false);
  });

  test("every string at every depth, a copy of the input, other values untouched", () => {
    const input = {
      title: "T ${1}",
      n: 5,
      ok: true,
      none: null,
      list: ["a", "${b}", { deep: ["${c}"] }],
      "key ${not}": "kept",
    };
    const out = neutralizeStrings(input);
    expect(out).toEqual({
      title: `T ${INERT}1}`,
      n: 5,
      ok: true,
      none: null,
      list: ["a", `${INERT}b}`, { deep: [`${INERT}c}`] }],
      "key ${not}": "kept",
    });
    // the input is not changed
    expect(input.title).toBe("T ${1}");
    expect(input.list[1]).toBe("${b}");
  });
});

describe("restoreText: the marker is written back as text, where it is text", () => {
  test("in a text node it becomes `&#36;{`, which is how Jx writes a `${` that is text", () => {
    expect(restoreText(`<p>Set ${INERT}HOME} first</p>`)).toBe("<p>Set &#36;{HOME} first</p>");
    expect(restoreText(`<code>${INERT}PORT}</code>`)).toBe("<code>&#36;{PORT}</code>");
  });

  test("an attribute value keeps the marker, quoted either way, and so does a comment", () => {
    const html = `<a href="https://e.org/${INERT}x}" title='${INERT}y}'>t ${INERT}z}</a><!-- ${INERT}c} -->`;
    expect(restoreText(html)).toBe(
      `<a href="https://e.org/${INERT}x}" title='${INERT}y}'>t &#36;{z}</a><!-- ${INERT}c} -->`,
    );
  });

  test("a `>` inside a quoted attribute does not end the tag early", () => {
    const html = `<a title="a > ${INERT}x}">${INERT}y}</a>`;
    expect(restoreText(html)).toBe(`<a title="a > ${INERT}x}">&#36;{y}</a>`);
  });

  test("the head is the exception: the text of <title> and the attributes of <meta> get the plain `${` back", () => {
    const html =
      `<head><title>Set ${INERT}HOME} safely</title>` +
      `<meta name="description" content="Use ${INERT}HOME} &amp; more">` +
      `<meta property="og:title" content='${INERT}x}'></head>` +
      `<body><h1>Set ${INERT}HOME}</h1><a href="/x/${INERT}y}" title="${INERT}z}">t</a></body>`;
    expect(restoreText(html)).toBe(
      "<head><title>Set ${HOME} safely</title>" +
        '<meta name="description" content="Use ${HOME} &amp; more">' +
        "<meta property=\"og:title\" content='${x}'></head>" +
        `<body><h1>Set &#36;{HOME}</h1><a href="/x/${INERT}y}" title="${INERT}z}">t</a></body>`,
    );
  });

  test("the content of script and style is not text of the page: it stays as it is", () => {
    const html = `<script>var a = "${INERT}";</script><style>/* ${INERT} */</style><p>${INERT}</p>`;
    expect(restoreText(html)).toBe(
      `<script>var a = "${INERT}";</script><style>/* ${INERT} */</style><p>&#36;{</p>`,
    );
  });

  test("a highlighted code block can split the marker between tokens: the tags stay, the marker goes", () => {
    const html = `<pre><code><span>echo $</span>${ZWSP}<span>{HOME}</span></code></pre>`;
    expect(restoreText(html)).toBe(
      "<pre><code><span>echo $</span><span>{HOME}</span></code></pre>",
    );
    const first = `<span>$</span><span>${ZWSP}{HOME}</span>`;
    expect(restoreText(first)).toBe("<span>$</span><span>{HOME}</span>");
  });

  test("the same string comes back when there is no marker", () => {
    const html = "<p>Plain &#36;{already} text</p>";
    expect(restoreText(html)).toBe(html);
  });

  test("a tag that never closes does not make it loop or lose text", () => {
    expect(restoreText(`<p>${INERT}a} <b title="${INERT}b}`)).toBe(
      `<p>&#36;{a} <b title="${INERT}b}`,
    );
  });
});

describe("restoreData: the search index shows text, so the marker is not needed in it", () => {
  test("the marker goes, with or without the spaces that a tokenizer put around it", () => {
    expect(restoreData(`{"text":"Set ${INERT}HOME} and $ ${ZWSP}{PORT}"}`)).toBe(
      '{"text":"Set ${HOME} and $ {PORT}"}',
    );
    expect(restoreData('{"text":"a $\\u200b{b}"}')).toBe('{"text":"a ${b}"}');
  });

  test("the same string comes back when there is no marker", () => {
    const json = '{"text":"price $5 and {x}"}';
    expect(restoreData(json)).toBe(json);
  });
});

describe("expressionsIn: where a `${` is, in any spelling", () => {
  test("offsets of every one, spelled any way", () => {
    expect(expressionsIn("a ${b} c &#36;{d} e $\\{f}")).toEqual([2, 9, 20]);
    expect(expressionsIn("nothing here $ {x}")).toEqual([]);
  });
});
