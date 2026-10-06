import { expect, test } from "vitest";
import {
  codeSpans,
  destinations,
  htmlAttributes,
  lines,
  withoutCode,
} from "../../src/lib/markdown.js";

test("lines marks fenced code, with the fences themselves", () => {
  const out = lines("a\n```bash\n[x](y)\n```\nb\n~~~\ncode\n~~~\nc");
  expect(out.map((l) => l.code)).toEqual([false, true, true, true, false, true, true, true, false]);
  expect(out[1]!.fence).toBe("bash");
  // A longer fence is not closed by a shorter one, and a different character does not close it.
  const nested = lines("````md\n```\ninner\n```\n````\nafter");
  expect(nested.map((l) => l.code)).toEqual([true, true, true, true, true, false]);
  expect(lines("```\nopen forever\ntext").every((l) => l.code)).toBe(true);
  // A fence inside a list item is indented by the item, which can be four spaces or more.
  const listed = lines("10. Step\n\n    ```bash\n    [x](y.md)\n    ```\n\n    after");
  expect(listed.map((l) => l.code)).toEqual([false, false, true, true, true, false, false]);
  // Three backticks followed by more backticks on the line are a code span, not a fence.
  expect(lines("```not a fence``` but text\nnext").map((l) => l.code)).toEqual([false, false]);
  expect(lines("a\r\nb").map((l) => l.text)).toEqual(["a", "b"]);
});

test("inline code spans are found, including double-backtick ones", () => {
  const text = "a `b` c ``d ` e`` f `unclosed";
  expect(codeSpans(text).map(([a, b]) => text.slice(a, b))).toEqual(["`b`", "``d ` e``"]);
  expect(withoutCode("x `[a](b)` y")).toBe(`x${" ".repeat(10)}y`);
  expect(codeSpans("escaped \\`not code\\`")).toEqual([]);
});

test("link and image destinations are found with their offsets", () => {
  const text =
    'See [a](one.md), ![img](two.png "title") and [<c>](<three four.md>) and [d](f(g).md).';
  const found = destinations(text);
  expect(found.map((d) => d.value)).toEqual(["one.md", "two.png", "three four.md", "f(g).md"]);
  expect(found.map((d) => d.image)).toEqual([false, true, false, false]);
  expect(found.map((d) => d.angle)).toEqual([false, false, true, false]);
  for (const d of found) expect(text.slice(d.start, d.end)).toBe(d.value);
});

test("a badge (a link around an image) gives both destinations; code and escapes are skipped", () => {
  const found = destinations("[![CI](https://img.x/b.svg)](https://x/actions)");
  expect(found.map((d) => [d.value, d.image])).toEqual([
    ["https://img.x/b.svg", true],
    ["https://x/actions", false],
  ]);
  expect(destinations("`[a](b.md)` and \\[c](d.md)")).toEqual([]);
  expect(destinations("[unbalanced](a(b.md)")).toEqual([]);
  expect(destinations("[text only] (not a link)")).toEqual([]);
  expect(destinations("[empty]()").map((d) => d.value)).toEqual([""]);
});

const WANTED = new Map([
  ["a", ["href"]],
  ["img", ["src", "srcset"]],
]);

/** The attributes found, as `tag.name=value`, and a check that each offset points at its value. */
function attributes(text: string): string[] {
  const found = htmlAttributes(text, WANTED);
  for (const a of found) expect(text.slice(a.start, a.end)).toBe(a.value);
  return found.map((a) => `${a.tag}.${a.name}=${a.value}`);
}

test("htmlAttributes finds the wanted attributes of raw tags, with the offsets of their values", () => {
  expect(attributes('<p align="center"><img src="./logo.png" alt="logo" width="100"></p>')).toEqual(
    ["img.src=./logo.png"],
  );
  // quotes of either kind, no quotes, any case, a self-closing tag, other attributes in between
  expect(
    attributes(
      `<IMG SRC='a b.png' alt=x><a data-x="1" href=docs/x.md class="c">t</a><img src="z.png"/>`,
    ),
  ).toEqual(["img.src=a b.png", "a.href=docs/x.md", "img.src=z.png"]);
  // a value may hold `>` and `<` in quotes; a tag may span lines
  expect(attributes('<img alt="a > b" src="x.png">')).toEqual(["img.src=x.png"]);
  expect(attributes('<img\n  src="a.png"\r\n  srcset="b.png 1x, c.png 2x"\n  alt="x" />')).toEqual([
    "img.src=a.png",
    "img.srcset=b.png 1x, c.png 2x",
  ]);
  // tags and attributes that were not asked for are not reported; neither is a valueless attribute
  expect(attributes('<iframe src="a.html"></iframe><a name="x"></a><img src alt="x">')).toEqual([]);
});

test("htmlAttributes skips code, comments and what is not a tag", () => {
  const text = [
    '<img src="one.png">',
    "```html",
    '<img src="in-fence.png">',
    "```",
    'Inline `<img src="in-span.png">` text <img src="two.png">',
    '<!-- <img src="in-comment.png"> -->',
    "<!--",
    '<a href="in-long-comment.md">',
    "-->",
    '<img src="no-end.png"',
    "",
    "text > here",
    '<a href="three.md" <b>',
    "<img/src=x.png>",
    '<img src="four.png">',
  ].join("\n");
  expect(attributes(text)).toEqual(["img.src=one.png", "img.src=two.png", "img.src=four.png"]);
  // a comment that is never closed runs to the end, as in CommonMark
  expect(attributes('<!-- <img src="a.png">\n<img src="b.png">')).toEqual([]);
});
