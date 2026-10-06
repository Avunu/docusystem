// A small reader for the Markdown that documentation files contain: it walks the prose of a file
// (everything outside fenced code blocks and inline code spans) and finds link and image
// destinations. stage.ts rewrites them and lint.ts looks for constructs the site cannot render. It is
// not a Markdown parser: it knows exactly as much as those two need, and each of them is tested with
// the shapes real README files use.

/** One line of a file, with its 0-based index and whether it is inside a fenced code block. */
export interface Line {
  text: string;
  index: number;
  /** In a fenced code block, or one of its fence lines. */
  code: boolean;
  /** The info string of the opening fence (`bash`), on the opening line only. */
  fence?: string;
}

/**
 * Splits a document into lines and marks the ones inside fenced code blocks (``` and ~~~). A fence
 * may be indented as far as the list item it sits in (a block under "10." is four spaces in), so any
 * indentation opens one; a backtick fence whose info string holds a backtick is a code span, not a fence.
 */
export function lines(source: string): Line[] {
  const out: Line[] = [];
  let open: string | null = null;
  source.split(/\r?\n/).forEach((text, index) => {
    const fence = /^\s*(`{3,}|~{3,})(.*)$/.exec(text);
    const info = fence ? fence[2]!.trim() : "";
    if (open) {
      const closes = fence && fence[1]![0] === open[0] && fence[1]!.length >= open.length && !info;
      out.push({ text, index, code: true });
      if (closes) open = null;
      return;
    }
    if (fence && !(fence[1]![0] === "`" && info.includes("`"))) {
      open = fence[1]!;
      out.push({ text, index, code: true, fence: info.split(/\s+/)[0] ?? "" });
      return;
    }
    out.push({ text, index, code: false });
  });
  return out;
}

/** `[start, end)` offsets of the inline code spans of a line (a run of backticks to the next run of the same length). */
export function codeSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === "\\") {
      i += 2;
      continue;
    }
    if (text[i] !== "`") {
      i++;
      continue;
    }
    let run = 1;
    while (text[i + run] === "`") run++;
    const ticks = "`".repeat(run);
    let close = text.indexOf(ticks, i + run);
    while (close !== -1 && text[close + run] === "`") {
      // a longer run does not close this one
      let longer = run;
      while (text[close + longer] === "`") longer++;
      close = text.indexOf(ticks, close + longer);
    }
    if (close === -1) {
      i += run;
      continue;
    }
    spans.push([i, close + run]);
    i = close + run;
  }
  return spans;
}

/** The text of a line with its inline code spans blanked out (same length, so offsets still match). */
export function withoutCode(text: string): string {
  let out = "";
  let at = 0;
  for (const [a, b] of codeSpans(text)) {
    out += text.slice(at, a) + " ".repeat(b - a);
    at = b;
  }
  return out + text.slice(at);
}

export interface Destination {
  /** Offset of the first character of the destination in the line (after `<` when angle-bracketed). */
  start: number;
  /** Offset just past the last character of the destination. */
  end: number;
  value: string;
  /** The destination was written `<like this>`. */
  angle: boolean;
  /** `![alt](dest)`, as opposed to `[text](dest)`. */
  image: boolean;
}

/**
 * The inline link and image destinations of one line of prose: `[text](dest "title")` and
 * `![alt](dest)`, including a link around an image (`[![badge](img)](url)`), which yields two.
 * Code spans are skipped. Destinations with unbalanced parentheses or a link text that does not
 * close on the line are left out.
 */
export function destinations(text: string): Destination[] {
  const spans = codeSpans(text);
  // The scan below moves forward only, so the spans are walked once rather than searched per character.
  let span = 0;
  const inCode = (at: number) => {
    while (span < spans.length && spans[span]![1] <= at) span++;
    return span < spans.length && at >= spans[span]![0];
  };
  const found: Destination[] = [];
  const stack: boolean[] = []; // true for an image opener
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (inCode(i)) continue;
    if (c === "!" && text[i + 1] === "[") {
      stack.push(true);
      i++;
    } else if (c === "[") {
      stack.push(false);
    } else if (c === "]") {
      const image = stack.pop();
      if (image === undefined || text[i + 1] !== "(") continue;
      const parsed = parseDestination(text, i + 2);
      if (parsed) found.push({ ...parsed.destination, image });
    }
  }
  return found.sort((a, b) => a.start - b.start);
}

/**
 * The most characters one destination, with its title, may take. A real address is far shorter; the
 * bound is what keeps a line of ten thousand `](` that never close from costing ten thousand
 * scans to the end of the line.
 */
const MAX_LINK = 2048;

/** Reads `dest "title")` starting just after the opening parenthesis. */
function parseDestination(
  text: string,
  from: number,
): { destination: Omit<Destination, "image">; next: number } | null {
  const limit = Math.min(text.length, from + MAX_LINK);
  let i = from;
  while (i < limit && (text[i] === " " || text[i] === "\t")) i++;
  let start = i;
  let end: number;
  let angle = false;
  if (text[i] === "<") {
    angle = true;
    start = i + 1;
    end = start;
    while (end < limit && text[end] !== ">" && text[end] !== "<" && text[end] !== "\n") end++;
    if (text[end] !== ">") return null;
    i = end + 1;
  } else {
    let depth = 0;
    end = i;
    while (end < limit) {
      const ch = text[end]!;
      if (ch === "\\") {
        end += 2;
        continue;
      }
      if (ch === "(") depth++;
      else if (ch === ")") {
        if (depth === 0) break;
        depth--;
      } else if (/\s/.test(ch)) break;
      end++;
    }
    if (depth !== 0 || (end >= limit && limit < text.length)) return null;
    i = end;
  }
  while (i < limit && (text[i] === " " || text[i] === "\t")) i++;
  if (text[i] === '"' || text[i] === "'" || text[i] === "(") {
    const close = text[i] === "(" ? ")" : text[i]!;
    let j = i + 1;
    while (j < limit && text[j] !== close) j += text[j] === "\\" ? 2 : 1;
    if (j >= limit) return null;
    i = j + 1;
    while (i < limit && (text[i] === " " || text[i] === "\t")) i++;
  }
  if (text[i] !== ")") return null;
  return { destination: { start, end, value: text.slice(start, end), angle }, next: i + 1 };
}
