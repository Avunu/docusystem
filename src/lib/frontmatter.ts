// Frontmatter and plain-text helpers for the documentation files. They read a page the way the Jx
// Markdown loader does (YAML between two --- lines at the very top) and add what the sidebar needs:
// the first heading and the first paragraph.
import { LineCounter, isAlias, isCollection, parseDocument, visit } from "yaml";
import { codeSpans } from "./markdown.js";

export interface Parsed {
  data: Record<string, unknown>;
  body: string;
}

/** The frontmatter of a file is not usable; `line` is where the problem is in the file (1-based). */
export class FrontmatterError extends Error {
  line: number;
  /** The problem without the file name in front of it. */
  reason: string;

  constructor(file: string, reason: string, line: number, options?: ErrorOptions) {
    super(`${file}: the frontmatter ${reason}`, options);
    this.name = "FrontmatterError";
    this.reason = reason;
    this.line = line;
  }
}

/**
 * The one-line reason a YAML parser gives and the line it points at, counted in the file (the
 * opening `---` is line 1, so the YAML text starts on line 2).
 */
function yamlProblem(error: unknown): { reason: string; line: number } {
  const first = ((error as Error).message ?? "").split("\n")[0] ?? "";
  const reason = first.replace(/\s+at line \d+, column \d+:?$/, "").trim() || "unreadable";
  const at = (error as { linePos?: Array<{ line: number }> }).linePos?.[0]?.line;
  return { reason, line: typeof at === "number" ? at + 1 : 1 };
}

/**
 * The most YAML a page may carry between its two `---` lines. Real frontmatter is a few lines; the
 * YAML parser's cost grows faster than its input for some malformed text (tens of milliseconds for
 * 16 KiB, seconds for 80 KiB), and a page is not the place for data that large.
 */
export const MAX_FRONTMATTER = 64 * 1024;

/**
 * Reads the YAML of a page: the value, or a FrontmatterError that says what is wrong and where.
 * Warnings (an unknown tag) are not printed: they would be stray lines of Node output in the middle
 * of the build's own messages. A key that is itself a list or a mapping (`? [a, b]`) is refused:
 * turning it into a property name costs time exponential in its nesting (800 characters of braces
 * took five seconds), and no page has such a key.
 */
function readYaml(yaml: string, file: string): unknown {
  if (yaml.length > MAX_FRONTMATTER) {
    throw new FrontmatterError(
      file,
      `is larger than ${MAX_FRONTMATTER / 1024} KiB: it is page metadata, not the place for data`,
      1,
    );
  }
  const lineCounter = new LineCounter();
  try {
    const doc = parseDocument(yaml, { logLevel: "error", lineCounter });
    const [problem] = doc.errors;
    if (problem !== undefined) throw problem;
    let offending: number | null = null;
    visit(doc, {
      Pair(_key, pair) {
        if (isCollection(pair.key) || isAlias(pair.key)) {
          offending = pair.key.range?.[0] ?? 0;
          return visit.BREAK;
        }
        return undefined;
      },
    });
    if (offending !== null) {
      throw new FrontmatterError(
        file,
        "has a key that is a list, a mapping or an alias: keys must be plain text",
        lineCounter.linePos(offending).line + 1,
      );
    }
    return doc.toJS();
  } catch (error) {
    if (error instanceof FrontmatterError) throw error;
    const { reason, line } = yamlProblem(error);
    throw new FrontmatterError(file, `is not valid YAML (${reason})`, line, { cause: error });
  }
}

/**
 * Splits a Markdown source into frontmatter data and body. Throws a FrontmatterError (whose message
 * starts with the file name) on bad YAML or on frontmatter that is not a mapping.
 */
export function parseFrontmatter(source: string, file = "document"): Parsed {
  const text = source.replace(/^\uFEFF/, "");
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) return { data: {}, body: text };
  const body = text.slice(match[0].length);
  const yaml = match[1] ?? "";
  if (yaml.trim() === "") return { data: {}, body };
  const parsed = readYaml(yaml, file);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new FrontmatterError(file, "must be a YAML mapping (key: value lines)", 1);
  }
  return { data: parsed as Record<string, unknown>, body };
}

/**
 * Moves HTML comments that precede the frontmatter behind it. Hooks that stamp a copyright line into
 * every Markdown file (Frappe apps have one) put it before the `---`, which turns the frontmatter
 * into page text. Returns null when there is nothing to move: no comment, or no frontmatter behind
 * it.
 */
export function moveLeadingComment(source: string): string | null {
  const text = source.replace(/^\uFEFF/, "");
  const lead = /^(?:[ \t]*<!--[\s\S]*?-->[ \t]*\r?\n)+(?:[ \t]*\r?\n)*/.exec(text);
  if (!lead) return null;
  const rest = text.slice(lead[0].length);
  const front = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(rest);
  if (!front) return null;
  const comment = lead[0].replace(/\s+$/, "");
  const body = rest.slice(front[0].length).replace(/^(?:[ \t]*\r?\n)+/, "");
  const frontmatter = front[0].endsWith("\n") ? front[0] : `${front[0]}\n`;
  return `${frontmatter}\n${comment}\n\n${body}`;
}

/** Lines of the body that are not inside a fenced code block, with their original index. */
function proseLines(body: string): Array<{ line: string; index: number }> {
  const out: Array<{ line: string; index: number }> = [];
  let fence: string | null = null;
  body.split(/\r?\n/).forEach((line, index) => {
    const open = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (open && open[1]![0] === fence[0] && open[1]!.length >= fence.length) fence = null;
      return;
    }
    if (open) {
      fence = open[1]!;
      return;
    }
    out.push({ line: line.length > MAX_INLINE ? line.slice(0, MAX_INLINE) : line, index });
  });
  return out;
}

/** The longest Markdown `inlineText` reads, and the longest line `firstHeading` and `firstParagraph` look at. */
const MAX_INLINE = 4000;

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&nbsp;": " ",
};

/**
 * The plain text of a line of Markdown, as a page title shows it: links, images, emphasis and tags
 * go, and the text of code spans stays exactly as written (`Array<string>` and `my_file` are
 * kept whole). Emphasis markers are only read as such where Markdown reads them: `_` inside a word
 * (snake_case) and a `*` that is followed by a space stay.
 */
export function inlineText(markdown: string): string {
  // No title or description needs more, and the patterns below are not linear in the worst case.
  const source = markdown.length > MAX_INLINE ? markdown.slice(0, MAX_INLINE) : markdown;
  const codes: string[] = [];
  let stripped = "";
  let at = 0;
  for (const [a, b] of codeSpans(source)) {
    let ticks = 0;
    while (source[a + ticks] === "`") ticks++;
    codes.push(source.slice(a + ticks, b - ticks).replace(/^ (.*) $/, "$1"));
    stripped += `${source.slice(at, a)}\uE000${codes.length - 1}\uE000`;
    at = b;
  }
  stripped += source.slice(at);
  const text = stripped
    .replaceAll(
      /\\([\\`*_{}[\]()#+.!|<>~-])/g,
      (_m, char: string) => `\uE001${char.charCodeAt(0)}\uE001`,
    )
    .replaceAll(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replaceAll(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replaceAll(/\[([^\]]*)\]\[[^\]]*\]/g, "$1")
    .replaceAll(/<((?:https?|mailto):[^>\s]+)>/g, "$1")
    .replaceAll(/<\/?[a-z][^<>]*>/gi, "")
    .replaceAll(/(\*{1,3})(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replaceAll(/(?<![A-Za-z0-9_])(_{1,3})(?=\S)([\s\S]*?\S)\1(?![A-Za-z0-9_])/g, "$2")
    .replaceAll(/~~(?=\S)([\s\S]*?\S)~~/g, "$1")
    .replaceAll(/&(?:amp|lt|gt|quot|nbsp|#39);/g, (entity) => ENTITIES[entity] ?? entity)
    .replaceAll(/\s+/g, " ")
    .trim();
  return text
    .replaceAll(/\uE000(\d+)\uE000/g, (_m, i: string) => codes[Number(i)] ?? "")
    .replaceAll(/\uE001(\d+)\uE001/g, (_m, code: string) => String.fromCharCode(Number(code)));
}

/** The text of the first level-1 heading outside code fences (`# Title` or a `===` underline). */
export function firstHeading(body: string): string | null {
  const lines = proseLines(body);
  for (const [i, { line }] of lines.entries()) {
    // A heading written in HTML (<h1 align="center">Title</h1>), which READMEs use to centre it.
    const html = /^\s*(?:<[a-z][^>]*>\s*)*<h1\b[^>]*>(.+?)<\/h1>/i.exec(line);
    if (html) return inlineText(html[1]!) || null;
    const atx = /^ {0,3}#[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (atx) return inlineText(atx[1]!) || null;
    const next = lines[i + 1]?.line ?? "";
    if (line.trim() !== "" && !/^\s*[#>|`-]/.test(line) && /^ {0,3}=+[ \t]*$/.test(next)) {
      return inlineText(line) || null;
    }
  }
  return null;
}

/** The first paragraph of prose, flattened to plain text and cut at a word near `max` characters. */
export function firstParagraph(body: string, max = 160): string {
  const lines = proseLines(body);
  const paragraph: string[] = [];
  let length = 0;
  for (const { line } of lines) {
    const trimmed = line.trim();
    if (trimmed === "") {
      if (paragraph.length > 0) break;
      continue;
    }
    const skippable =
      /^#{1,6}\s/.test(trimmed) ||
      /^[>|]/.test(trimmed) ||
      /^([-*+]|\d+[.)])\s/.test(trimmed) ||
      /^<\/?[a-z]/i.test(trimmed) ||
      trimmed.startsWith("![") ||
      /^\[[^\]]+\]:\s/.test(trimmed) ||
      /^(-{3,}|\*{3,}|_{3,}|={3,})$/.test(trimmed) ||
      /^:{2,}/.test(trimmed);
    if (skippable) {
      if (paragraph.length > 0) break;
      continue;
    }
    paragraph.push(trimmed);
    length += trimmed.length + 1;
    if (length > MAX_INLINE) break; // the rest could not reach the description
  }
  const text = inlineText(paragraph.join(" "));
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, "")}…`;
}
