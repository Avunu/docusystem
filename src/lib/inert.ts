// Keeps a page's text from running code in the build.
//
// Jx treats every string that holds `${` as a template and evaluates it with `new Function`, in the
// build's own process and with the user's privileges. Its Markdown parser makes the text of a page
// inert (prose, code, headings, `alt` and `title`), but not what becomes an attribute: a link or
// image address, an autolink, a bare URL, any attribute of raw HTML (iframe src, data-*, style), the
// attributes of a directive, the language of a code fence. `[x](https://e.org/${expression})` in a
// documentation file therefore ran `expression` whenever the site was built, previewed or checked, in
// CI too: a pull request that only touches docs/ was code. The same goes for the strings that layouts
// hand to components as props (a folder's title, the project name), which Jx evaluates twice.
//
// The defense does not depend on understanding Markdown. Whatever a page says, nothing that reaches
// Jx holds `${`:
//
//   1. staging (stage.ts) writes every `${` of a page, in any of the spellings that Markdown or HTML
//      decodes to it (`&#36;{`, `$\{`, `&dollar;&lbrace;`), as `$`, a zero-width space and `{`: the
//      spelling Jx's own parser uses for the attributes it makes inert. It does so in code too. A line
//      scanner cannot know what CommonMark reads as code in every container (a fence in a list item
//      in a quote, a tag that opens an HTML block), and a mistake in that direction is a hole.
//   2. the generated sidebar data is cleaned the same way (nav.ts) and the configuration's text is
//      refused when it holds one (config.ts).
//   3. after the build, restoreText writes the marker back as `&#36;{`, which is how Jx writes text
//      that holds `${`, in every text node of the output. Prose, headings and code blocks read as
//      they were written and a code sample can be copied. Attribute values keep the zero-width space,
//      which is where a `${` must not be live anyway (the runtime of the page reads them). The head
//      is the exception: nothing evaluates the text of `<title>` or the `content` of a `<meta>`, so
//      those, and the search index (data that the search box shows as text), get the plain `${` back.
//
// test/integration/jx-expressions.test.ts and its seeded random corpus build attacks with the real
// Jx and fail when any expression runs.

/** The zero-width space (written as a code point: an invisible character does not belong in source). */
const ZWSP = String.fromCodePoint(0x200b);
/** `$`, a zero-width space and `{`: Jx's own spelling for text that must not become a template. */
export const INERT = `$${ZWSP}{`;
/** The marker with at least one tag in the way: `$</span><span>` ZWSP `{`, or the space first. */
const ACROSS = new RegExp(
  `\\$((?:<[^<>]*>)+)${ZWSP}((?:<[^<>]*>)*)\\{|\\$((?:<[^<>]*>)*)${ZWSP}((?:<[^<>]*>)+)\\{`,
  "g",
);

// What is decoded to `$` and `{` before Jx sees a string: the characters, a backslash escape, the
// numeric and named character references (an HTML parser also takes a numeric reference without its
// semicolon). dollar, lbrace and lcub are the only names that character-entities has for the two.
const DOLLARS = [
  String.raw`\$`,
  String.raw`\\\$`,
  String.raw`&#0*36(?![0-9]);?`,
  String.raw`&#[xX]0*24(?![0-9a-fA-F]);?`,
  String.raw`&dollar;?`,
];
const BRACES = [
  String.raw`\{`,
  String.raw`\\\{`,
  String.raw`&#0*123(?![0-9]);?`,
  String.raw`&#[xX]0*7[bB](?![0-9a-fA-F]);?`,
  String.raw`&lbrace;?`,
  String.raw`&lcub;?`,
];
// YAML's own escapes in a double-quoted frontmatter value
const YAML_DOLLARS = [String.raw`\\x24`, String.raw`\\u0024`, String.raw`\\U00000024`];
const YAML_BRACES = [String.raw`\\x7[bB]`, String.raw`\\u007[bB]`, String.raw`\\U0000007[bB]`];

const spelling = (dollars: string[], braces: string[]): RegExp =>
  new RegExp(`(?:${dollars.join("|")})(?:${braces.join("|")})`, "g");
const BODY = spelling(DOLLARS, BRACES);
const FRONTMATTER = spelling([...DOLLARS, ...YAML_DOLLARS], [...BRACES, ...YAML_BRACES]);
/** Cheap test for "can there be a spelling of `${` in this text at all". */
const MAYBE = /\$|&#|&dollar|\\[xuU]/;

/** The offsets of every `${`, in any spelling Markdown or HTML decodes to it, in a line of Markdown. */
export function expressionsIn(text: string): number[] {
  return [...text.matchAll(BODY)].map((m) => m.index);
}

/** Whether a string of data holds an expression for Jx (the plain spelling). */
export function hasExpression(value: string): boolean {
  return value.includes("${");
}

/** A string of data (a title, a label, a path) with `${` spelled so that Jx cannot evaluate it. */
export function neutralizeData(value: string): string {
  return value.includes("${") ? value.replaceAll("${", INERT) : value;
}

/** Every string of a JSON-like value, through neutralizeData (a copy; the input is not changed). */
export function neutralizeStrings<T>(value: T): T {
  if (typeof value === "string") return neutralizeData(value) as T;
  if (Array.isArray(value)) return value.map((item) => neutralizeStrings(item)) as T;
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, neutralizeStrings(item)]),
    ) as T;
  }
  return value;
}

/** The lines of the frontmatter at the top of a file, its two `---` lines included (0 when there is none). */
function frontmatterLines(lines: string[]): number {
  if (!/^---[ \t]*$/.test((lines[0] ?? "").replace(/^﻿/, ""))) return 0;
  for (let at = 1; at < lines.length; at++) {
    if (/^(?:---|\.\.\.)[ \t]*$/.test(lines[at]!)) return at + 1;
  }
  return 0;
}

/**
 * A Markdown file with every `${`, in every spelling that Markdown, HTML or (in the frontmatter) YAML
 * decodes to it, written as `$`, a zero-width space and `{`. Lines and line endings are kept; the
 * same string comes back when there was nothing to write.
 */
export function neutralizeSource(source: string): string {
  if (!MAYBE.test(source)) return source;
  const parts = source.split(/(\r?\n)/);
  const head = frontmatterLines(parts.filter((_, at) => at % 2 === 0));
  let changed = false;
  for (let at = 0; at < parts.length; at += 2) {
    const line = parts[at]!;
    const next = line.replace(at / 2 < head ? FRONTMATTER : BODY, INERT);
    if (next !== line) {
      parts[at] = next;
      changed = true;
    }
  }
  return changed ? parts.join("") : source;
}

/** The end of the tag, comment or declaration that starts at `open`, past quoted attribute values. */
function tagEnd(html: string, open: number): number {
  if (html.startsWith("<!--", open)) {
    const close = html.indexOf("-->", open + 4);
    return close === -1 ? html.length : close + 3;
  }
  let quote = "";
  for (let at = open + 1; at < html.length; at++) {
    const ch = html[at]!;
    if (quote !== "") {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === ">") return at + 1;
  }
  return html.length;
}

/** The marker (and the spaces a tokenizer may have put around it) back to the `${` it stands for. */
const MARKER_IN_DATA = new RegExp(`\\$(\\s*)(?:${ZWSP}|\\\\u200[bB])(\\s*)\\{`, "g");

/**
 * Data that is only ever shown as text (the search index) with the marker written back as `${`. The
 * same string comes back when there was nothing to restore.
 */
export function restoreData(text: string): string {
  return text.replaceAll(MARKER_IN_DATA, "$$$1$2{");
}

/**
 * HTML with the marker of neutralizeSource written back as `&#36;{` in every text node, which is how
 * Jx writes a `${` that is text. Attribute values, comments and the content of script and style stay
 * as they are, except in the head: the text of `<title>` and the attributes of `<meta>` get the plain
 * `${` back, because nothing evaluates them. The same string comes back when there was nothing to
 * restore.
 */
export function restoreText(html: string): string {
  if (!html.includes(ZWSP)) return html;
  // A highlighted code block is split into tokens, and the split can fall between the `$` and the
  // `{`: the marker goes, and the tags stay between the two characters.
  html = html.replace(
    ACROSS,
    (_match, a1?: string, a2?: string, b1?: string, b2?: string) =>
      `$${a1 ?? b1 ?? ""}${a2 ?? b2 ?? ""}{`,
  );
  let out = "";
  let at = 0;
  let inTitle = false;
  while (at < html.length) {
    const open = html.indexOf("<", at);
    out += html
      .slice(at, open === -1 ? html.length : open)
      .replaceAll(INERT, inTitle ? "${" : "&#36;{");
    if (open === -1) break;
    let end = tagEnd(html, open);
    const raw = /^<(script|style)\b/i.exec(html.slice(open, open + 9));
    const tag = html.slice(open, end);
    if (/^<meta[\s/>]/i.test(tag)) {
      out += tag.replaceAll(INERT, "${");
    } else {
      if (/^<title[\s>]/i.test(tag)) inTitle = true;
      else if (/^<\/title[\s>]/i.test(tag)) inTitle = false;
      out += tag;
    }
    if (raw !== null) {
      // the content of these is not text of the page: copy it up to the closing tag
      const close = html.toLowerCase().indexOf(`</${raw[1]!.toLowerCase()}`, end);
      const stop = close === -1 ? html.length : close;
      out += html.slice(end, stop);
      end = stop;
    }
    at = end;
  }
  return out;
}
