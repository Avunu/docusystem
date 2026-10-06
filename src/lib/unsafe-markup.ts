// Finds what a documentation page may not carry in the Markdown a person wrote: raw HTML that runs
// code or loads other pages, event-handler attributes, `javascript:` and `data:` addresses in links,
// images and autolinks, and `:name{...}` directives that make the same things. The policy is
// html-policy.ts; this reads Markdown the way CommonMark and Jx do, so that each finding has the file
// and the line the author sees. It is the first of the three layers described there. The second, the
// assertions on the built pages (safety.ts), does not depend on how well this one reads Markdown.
//
// How the text is read:
//   - fenced code is never read (it is shown as text);
//   - an HTML block (CommonMark's seven start conditions, also inside a quote or a list item) is read
//     as HTML in full, including backticks and backslashes, which mean nothing inside it;
//   - every other run of lines is a paragraph: inline code spans are blanked, then the tags and
//     autolinks, the link and image destinations and the directives of the text are read. A comment
//     that is not closed in the paragraph is text, as in CommonMark, and hides nothing after it.
import { codeSpans, destinations, type Line } from "./markdown.js";
import {
  type Autolink,
  type Tag,
  attributeProblems,
  destinationText,
  hazardReason,
  readAt,
  tagProblems,
  tokens,
  unsafeAddressMessage,
  unsafeUrl,
} from "./html-policy.js";
import type { LintIssue } from "./types.js";

/** The most findings reported for one file; the rest are counted in a last one. */
const MAX_PER_FILE = 50;

/** CommonMark's block-level tag names (HTML block type 6). */
const BLOCK_TAG =
  /^<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?=[\s/>]|$)/i;
/** A complete open or closing tag alone on its line (HTML block type 7). */
const LONE_TAG =
  /^(?:<[A-Za-z][A-Za-z\d-]*(?:\s+[A-Za-z_:][\w:.-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>|<\/[A-Za-z][A-Za-z\d-]*\s*>)\s*$/;
/** What may stand before the `<` of a block that starts in a quote or a list item. */
const CONTAINER_PREFIX = /^(?:\s*>)*\s*(?:(?:[-*+]|\d{1,9}[.)])\s+)?\s*/;

/** How an HTML block that starts on a line ends: at a blank line, or after a line that matches. */
function blockStart(text: string): "blank" | RegExp | null {
  const rest = text.slice(CONTAINER_PREFIX.exec(text)![0].length);
  if (!rest.startsWith("<")) return null;
  if (/^<(?:script|pre|style|textarea)(?=[\s>]|$)/i.test(rest)) {
    return /<\/(?:script|pre|style|textarea)>/i;
  }
  if (rest.startsWith("<!--")) return /-->/;
  if (rest.startsWith("<?")) return /\?>/;
  if (rest.startsWith("<![CDATA[")) return /\]\]>/;
  if (/^<![A-Za-z]/.test(rest)) return />/;
  if (BLOCK_TAG.test(rest) || (rest.length < 4000 && LONE_TAG.test(rest))) return "blank";
  return null;
}

interface Segment {
  /** An HTML block: read as HTML in full. Otherwise a paragraph. */
  html: boolean;
  lines: Line[];
}

/** The HTML blocks and paragraphs of a document, in order. Fenced code and blank lines belong to none. */
function segmentsOf(all: Line[]): Segment[] {
  const segments: Segment[] = [];
  let paragraph: Line[] = [];
  const flush = (): void => {
    if (paragraph.length > 0) segments.push({ html: false, lines: paragraph });
    paragraph = [];
  };
  for (let at = 0; at < all.length; at++) {
    const line = all[at]!;
    if (line.code || line.text.trim() === "") {
      flush();
      continue;
    }
    const start = blockStart(line.text);
    if (start === null) {
      paragraph.push(line);
      continue;
    }
    flush();
    let end = at;
    if (start === "blank") {
      while (end + 1 < all.length && !all[end + 1]!.code && all[end + 1]!.text.trim() !== "") end++;
    } else {
      while (end < all.length - 1 && !start.test(all[end]!.text)) end++;
    }
    segments.push({ html: true, lines: all.slice(at, end + 1) });
    at = end;
  }
  flush();
  return segments;
}

/** A link reference definition whose destination is in angle brackets: `[label]: <address with spaces>`. */
const DEFINITION_BRACKETS = /^( {0,3}\[[^\]\n]*\]:[ \t]*)<[^<>\n]*>/gm;

const blanks = (text: string): string => text.replaceAll(/[^\n]/g, " ");

/**
 * Reads a paragraph left to right the way CommonMark's inline parser does, where a raw HTML tag, an
 * autolink and a code span compete for the same characters and the one that starts first wins: a tag
 * keeps the backticks inside it (`<a title="`" href=...>`), and a code span hides the tags inside it.
 * A backslash escape makes the next character text (`\<script>` is not a tag). Returns the tags and
 * autolinks found, the text with the code spans blanked (what the links and images read), and the
 * text with the tags blanked too (what the directives read): offsets and line breaks are kept.
 */
function readParagraph(text: string): {
  found: Array<Tag | Autolink>;
  noCode: string;
  noMarkup: string;
  /** The offset where reading gave up because of too many constructs that are never closed, or null. */
  overrun: number | null;
} {
  const found: Array<Tag | Autolink> = [];
  const spans = codeSpans(text);
  let span = 0;
  let noCode = "";
  let noMarkup = "";
  let i = 0;
  // What failed attempts may look at in all: a text of ten thousand `<a ` with no `>` would otherwise
  // cost each of them a look at the rest of the text.
  let budget = 64 * text.length + 10_000;
  const take = (to: number, blank: "code" | "markup" | null): void => {
    const piece = text.slice(i, to);
    noCode += blank === "code" ? blanks(piece) : piece;
    noMarkup += blank === null ? piece : blanks(piece);
    i = to;
  };
  while (i < text.length) {
    const c = text[i];
    if (c === "\\") {
      take(i + 2, null);
      continue;
    }
    if (c === "`") {
      while (span < spans.length && spans[span]![1] <= i) span++;
      const hit = span < spans.length && spans[span]![0] === i ? spans[span]! : null;
      take(hit !== null ? hit[1] : i + 1, hit !== null ? "code" : null);
      continue;
    }
    if (c === "<") {
      const read = readAt(text, i, { autolinks: true, inline: true });
      budget -= read.scanned ?? 0;
      if (budget < 0) return { found, noCode, noMarkup, overrun: i };
      if (read.end > i + 1) {
        if (read.token !== undefined) found.push(read.token);
        take(read.end, "markup");
        continue;
      }
    }
    take(i + 1, null);
  }
  return { found, noCode, noMarkup, overrun: null };
}

/**
 * The directive syntax of remark-directive: `:name[label]{attributes}`, `::name{...}` and
 * `:::name{...}`. The name must not follow a word character or another colon, so `10:30` and `a::b`
 * are not directives.
 */
const DIRECTIVE =
  /(?<![\w:]):{1,3}([A-Za-z][\w-]{0,63})(?:\[[^\]\n]{0,4000}\])?(?:\{([^}\n]{0,4000})\})?/g;
/** One attribute of a directive: `key`, `key=value`, `key="value"` or `key='value'`. */
const DIRECTIVE_ATTRIBUTE =
  /([^\s=}"'.#][^\s=}"']*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`}]+)))?/g;

/** Directive attributes that Jx treats as structure (markup, scripts and references), not as plain attributes. */
const STRUCTURAL = new Set([
  "innerhtml",
  "textcontent",
  "children",
  "style",
  "srcdoc",
  "formaction",
]);

/** The problems of the directives in a paragraph, as `[offset, message]`. */
function directiveProblems(text: string): Array<[number, string]> {
  const found: Array<[number, string]> = [];
  for (const m of text.matchAll(DIRECTIVE)) {
    const at = m.index ?? 0;
    const name = m[1]!.toLowerCase();
    // A directive makes an element of that name with its attributes: the policy for raw HTML applies,
    // except that an unknown name only makes an empty element (the output check looks at the result).
    const why = hazardReason(name);
    if (why !== null) {
      found.push([
        at,
        `The directive :${m[1]!} makes a <${name}> element, which is not allowed in documentation: ${why}. If this is not a directive, put it in backticks.`,
      ]);
      continue;
    }
    for (const a of (m[2] ?? "").matchAll(DIRECTIVE_ATTRIBUTE)) {
      const key = a[1]!.toLowerCase();
      const value = a[2] ?? a[3] ?? a[4] ?? "";
      if (key.startsWith("$") || STRUCTURAL.has(key)) {
        found.push([
          at,
          `The attribute ${a[1]!} of the directive :${m[1]!} writes markup or Jx internals into the page (it can run code): remove it.`,
        ]);
      } else {
        for (const message of attributeProblems(name, { name: key, value }))
          found.push([at, message]);
      }
    }
  }
  return found;
}

/** The unsafe constructs of the Markdown lines of a file: errors of the rules `unsafe-html`, `unsafe-url` and `unsafe-directive`, and warnings of `html-unknown`. */
export function unsafeMarkup(all: Line[], file: string): LintIssue[] {
  const issues: LintIssue[] = [];
  let more = 0;
  for (const segment of segmentsOf(all)) {
    const text = segment.lines.map((l) => l.text).join("\n");
    const starts: number[] = [];
    let offset = 0;
    for (const l of segment.lines) {
      starts.push(offset);
      offset += l.text.length + 1;
    }
    const lineAt = (position: number): number => {
      let low = 0;
      let high = starts.length - 1;
      while (low < high) {
        const mid = (low + high + 1) >> 1;
        if (starts[mid]! <= position) low = mid;
        else high = mid - 1;
      }
      return segment.lines[low]!.index + 1;
    };
    const add = (
      position: number,
      rule: string,
      message: string,
      level: LintIssue["level"] = "error",
    ): void => {
      if (issues.length >= MAX_PER_FILE) {
        more++;
        return;
      }
      issues.push({ file, line: lineAt(position), level, rule, message });
    };

    // The brackets of a reference definition are the syntax of its destination, not an HTML tag.
    const source = segment.html
      ? text
      : text.replaceAll(
          DEFINITION_BRACKETS,
          (whole, label: string) => label + " ".repeat(whole.length - label.length),
        );
    const paragraph = segment.html ? null : readParagraph(source);
    const found = paragraph?.found ?? tokens(text);
    // Links and images: a destination may start on the line after its parenthesis, so the line
    // breaks of the paragraph are read as spaces (the offsets stay).
    const links = paragraph === null ? [] : destinations(paragraph.noCode.replaceAll("\n", " "));
    // `[x](<address>)`: the brackets are the destination's syntax, and not also an autolink.
    const bracketed = new Set(links.filter((dest) => dest.angle).map((dest) => dest.start - 1));
    for (const token of found) {
      if (token.kind === "autolink") {
        if (bracketed.has(token.start)) continue;
        const bad = unsafeUrl(token.url);
        if (bad !== null) {
          add(token.start, "unsafe-url", unsafeAddressMessage("the autolink", token.url, bad));
        }
        continue;
      }
      for (const problem of tagProblems(token))
        add(token.start, problem.rule, problem.message, problem.level);
    }
    if (paragraph === null) continue;
    if (paragraph.overrun !== null) {
      add(
        paragraph.overrun,
        "unsafe-html",
        "This paragraph has so many tags, comments or quotes that are never closed that it cannot be checked for scripts and event handlers. Close them, or put the text in backticks.",
      );
    }
    for (const dest of links) {
      const address = destinationText(dest.value);
      const bad = unsafeUrl(address);
      if (bad !== null) {
        const where = dest.image ? "the image" : "the link";
        add(dest.start, "unsafe-url", unsafeAddressMessage(where, address, bad));
      }
    }
    for (const [position, message] of directiveProblems(paragraph.noMarkup)) {
      add(position, "unsafe-directive", message);
    }
  }
  if (more > 0) {
    issues.push({
      file,
      line: issues.at(-1)?.line ?? 1,
      level: "error",
      rule: "unsafe-html",
      message: `${more} more unsafe construct${more === 1 ? "" : "s"} in this file are not listed.`,
    });
  }
  return issues;
}
