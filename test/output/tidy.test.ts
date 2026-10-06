import { existsSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  dropEmptySlots,
  fixHighlightedCode,
  publishNotFoundPage,
  tidyHtml,
  tidyPage,
} from "../../src/lib/tidy.js";
import { tempDir, writeTree } from "../support/index.js";

test("removes the emitter separator before punctuation and keeps authored spaces", () => {
  const html = '<p>Some \n  <code>inline</code>\n   and a \n  <a href="/x/">link</a>\n  .</p>';
  expect(tidyHtml(html)).toBe('<p>Some <code>inline</code> and a <a href="/x/">link</a>.</p>');
});

test("handles the unindented separator used inside components", () => {
  expect(tidyHtml("<p>See <b>this</b>\n, and <i>that</i>\n and more</p>")).toBe(
    "<p>See <b>this</b>, and <i>that</i> and more</p>",
  );
});

test("collapses real soft breaks to one space and joins block siblings", () => {
  expect(tidyHtml("<p><span>a</span>\n\n\n<span>b</span></p>")).toBe(
    "<p><span>a</span> <span>b</span></p>",
  );
  expect(tidyHtml("<ul><li>a</li>\n  <li>b</li></ul>\n  <p>c</p>")).toBe(
    "<ul><li>a</li><li>b</li></ul><p>c</p>",
  );
  expect(tidyHtml("<p>line one\nline two</p>")).toBe("<p>line one\nline two</p>");
});

test("tidyHtml never touches pre, textarea, script or style", () => {
  const pre = '<pre><code><span class="t">a</span>\n<span class="t">b</span>\n</code></pre>';
  const script = "<script>\n  let a = 1;\n</script>";
  expect(tidyHtml(`<p>x\n  </p>${pre}${script}`)).toBe(`<p>x</p>${pre}${script}`);
});

/** What the emitter writes for a highlighted block inside a component: a newline between every pair of nodes. */
const emitted = (nodes: string[]): string => nodes.join("\n");
const span = (text: string, i = 0): string => `<span class="jxs-${i}">${text}</span>`;

test("highlighted code inside a component gets its separators back out and keeps its own newlines", () => {
  // Source:  git clone x\ncd x\n\nbun install
  const tokens = [
    span("git", 0),
    span(" ", 1),
    span("clone", 2),
    span(" x", 3),
    "\n",
    span("cd", 4),
    span(" x", 5),
    "\n",
    "\n",
    span("bun", 6),
    span(" install", 7),
  ];
  const html = `<docs-prose><pre><code class="language-bash shiki">${emitted(tokens)}</code></pre></docs-prose>`;
  const fixed = fixHighlightedCode(html);
  const code = /<code[^>]*>([\s\S]*)<\/code>/.exec(fixed)![1]!;
  expect(code.replaceAll(/<[^>]+>/g, "")).toBe("git clone x\ncd x\n\nbun install");
  expect(code).toContain(`${span("git", 0)}${span(" ", 1)}`);
});

test("a code block nested deeper in components is fixed too", () => {
  const tokens = [span("a", 0), "\n", span("b", 1)];
  const html = `<docs-prose><docs-callout><div class="body"><pre><code class="language-text shiki">${emitted(tokens)}</code></pre></div></docs-callout></docs-prose>`;
  expect(
    /<code[^>]*>([\s\S]*)<\/code>/.exec(fixHighlightedCode(html))![1]!.replaceAll(/<[^>]+>/g, ""),
  ).toBe("a\nb");
});

test("code outside a component, and code that is not highlighted, is left exactly as emitted", () => {
  const outside = `<article><pre><code class="language-bash shiki">${emitted([span("a", 0), span("b", 1)])}</code></pre></article>`;
  expect(fixHighlightedCode(outside)).toBe(outside);
  const plain = "<docs-prose><pre><code>line one\nline two</code></pre></docs-prose>";
  expect(fixHighlightedCode(plain)).toBe(plain);
});

test("tags the scanner cannot nest do not confuse it", () => {
  const html = `<docs-prose><img src="a.png"><br><p>text <b>x</b></p><script>if (a < b) {}</script><pre><code class="shiki">${emitted([span("a", 0), span("b", 1)])}</code></pre><p>after</p></docs-prose>`;
  const fixed = fixHighlightedCode(html);
  expect(fixed).toContain(`<code class="shiki">${span("a", 0)}${span("b", 1)}</code>`);
  expect(fixed).toContain("<p>after</p>");
});

test("empty slot elements go, filled ones stay", () => {
  expect(
    dropEmptySlots(
      '<span>Done<slot></slot></span><div><slot name="a"></slot></div><slot>fallback</slot>',
    ),
  ).toBe("<span>Done</span><div></div><slot>fallback</slot>");
});

test("tidyPage applies all three", () => {
  const html = `<docs-prose><p>Run \n<code>x</code>\n.</p><slot></slot><pre><code class="shiki">${emitted([span("a", 0), span("b", 1)])}</code></pre></docs-prose>`;
  const out = tidyPage(html);
  expect(out).toContain("<p>Run <code>x</code>.</p>");
  expect(out).not.toContain("<slot>");
  expect(out).toContain(`${span("a", 0)}${span("b", 1)}`);
});

test("tidyHtml and dropEmptySlots are idempotent", () => {
  const html = "<p>Run \n<code>x</code>\n.</p>\n  <ul><li>a</li>\n  <li>b</li></ul><slot></slot>";
  const once = dropEmptySlots(tidyHtml(html));
  expect(dropEmptySlots(tidyHtml(once))).toBe(once);
});

test("404/index.html is published as 404.html and the folder removed", () => {
  const root = writeTree(tempDir(), {
    "404/index.html": "<title>Not found</title>",
    "404/index.md": "# copy",
  });
  expect(publishNotFoundPage(root)).toBe(true);
  expect(readFileSync(join(root, "404.html"), "utf8")).toBe("<title>Not found</title>");
  expect(existsSync(join(root, "404"))).toBe(false);
  expect(publishNotFoundPage(tempDir())).toBe(false);
});

test("an existing 404.html is replaced by the page Jx built", () => {
  const root = writeTree(tempDir(), { "404.html": "old", "404/index.html": "new" });
  expect(publishNotFoundPage(root)).toBe(true);
  expect(readFileSync(join(root, "404.html"), "utf8")).toBe("new");
});

test("a folder named 404 with no page in it is left alone", () => {
  const root = writeTree(tempDir(), { "404/notes.txt": "x" });
  expect(publishNotFoundPage(root)).toBe(false);
  expect(existsSync(join(root, "404", "notes.txt"))).toBe(true);
});

test("a symbolic link where the 404 folder should be is removed, never followed", () => {
  const outside = writeTree(tempDir(), { "index.html": "<title>x</title>", "keep.txt": "keep" });
  const root = tempDir();
  symlinkSync(outside, join(root, "404"));
  expect(publishNotFoundPage(root)).toBe(true);
  expect(existsSync(join(root, "404"))).toBe(false);
  expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("keep");
});
