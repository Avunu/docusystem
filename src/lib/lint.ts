// Finds Markdown that the site cannot render the way GitHub and Obsidian do. Jx drops or reshapes a
// few common constructs without a word, and a page that quietly loses a sentence is worse than a
// build that says so. The rules, each found while building the real READMEs of Avunu's repositories:
//
//   error    reference-style links ([text][ref] and its definition): the text of every link that uses
//            one vanishes, as does an image's alt text
//   error    footnotes ([^1]): the marker and the note both vanish
//   error    frontmatter that is not valid YAML: the page cannot be built
//   error    <a href> around text, or around an <img> (a badge), in a paragraph: Jx writes an empty
//            link and puts the text or the image after it, and the output assertion "no page has an
//            empty link" then fails the build in every mode, --lenient included. (An error here, so a
//            strict build says so with file:line before it runs Jx; a lenient one prints it as a
//            warning and the assertion that follows is what fails it.)
//   warning  inline HTML elements (<kbd>, <b>, <sub>, an <a> without href): the text stays but sits
//            outside the element, so the formatting is lost
//   warning  an HTML block that a blank line ends before its closing tag (<div align="center">,
//            <details>): the wrapper is left empty and its content follows it
//   warning  task-list checkboxes (- [ ]) are shown as plain list items
//   warning  column alignment in tables is not applied
//   warning  ${...} in a link destination is evaluated by Jx and drops the link
//
// Errors fail a strict build (CI); warnings are printed. Step 6 of the pipeline runs this over the
// original docs/ folder (not the staged copy), so file names and line numbers are the author's.
// The empty link itself (Jx emits a raw <a href> as `<a href></a>text`) is caught by the output
// assertions of WP4, which is why the two <a href> rules above are errors.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isExcluded, isPublished } from "./docs.js";
import { walkFiles } from "./fsutil.js";
import { FrontmatterError, moveLeadingComment, parseFrontmatter } from "./frontmatter.js";
import { destinations, lines, withoutCode } from "./markdown.js";
import type { LintIssue } from "./types.js";

/**
 * Inline elements whose content Jx moves out of the element. A tag of more than 2,000 characters is
 * not matched: the bound keeps a line of unterminated tags from costing a scan to the end of the
 * line for each of them.
 */
const INLINE =
  /<(kbd|b|i|em|strong|u|s|sub|sup|span|mark|small|abbr|del|ins|code|q|cite|var|samp|font|big|tt|a)(?=[\s/>])[^>]{0,2000}>/gi;
/** What follows an `<a ...>` that wraps an image (a badge). Sticky: it is tried at a given offset. */
const BADGE_TAIL = /\s*<img\b[^>]{0,2000}>\s*<\/a>/iy;
/**
 * An `<a ...>` opening tag the way a browser reads it: a quoted value may hold a `>`. Sticky: it is
 * tried at a given offset. Each alternative starts with a different character, so the bounded repeat
 * cannot be matched two ways.
 */
const ANCHOR_TAG = /<a((?:\s(?:[^>"']|"[^"]*"|'[^']*'){0,2000})?)>/iy;
/** An `href` attribute in the attribute text of a tag whose quoted values are already blanked. */
const HREF_ATTRIBUTE = /(?:^|\s)href(?=[\s=/>]|$)/i;
/**
 * Whether the `<a ...>` tag at `index` of `prose` is a link (it has an `href`): `<a id>` and
 * `<a name>` anchors are not, and Jx leaves them alone. `tag` is the tag as INLINE matched it, used
 * when the tag is not closed in the way a browser needs.
 */
function isLink(prose: string, index: number, tag: string): boolean {
  ANCHOR_TAG.lastIndex = index;
  const attributes = ANCHOR_TAG.exec(prose)?.[1] ?? tag.slice(2, -1);
  return HREF_ATTRIBUTE.test(attributes.replaceAll(/"[^"]*"|'[^']*'/g, '""'));
}
/** Why the two `<a href>` rules are errors, said the same way in both. */
const EMPTY_LINK =
  "which fails the build in every mode, --lenient included (Jx writes an empty link and puts what was inside it after the link)";
/**
 * A table's delimiter row (`|:--|--:|`): cells of two or more dashes, optional colons, pipes between,
 * optionally at both ends. Written so that no two parts can take the same whitespace, which keeps a
 * long run of spaces from costing a quadratic number of attempts.
 */
const DELIMITER_ROW = /^\s*(?:\|\s*)?:?-{2,}:?(?:\s*\|\s*:?-{2,}:?)*(?:\s*\|)?\s*$/;
/** The block-level tag names that start an HTML block (CommonMark type 6). */
const BLOCK_TAG =
  /^ {0,3}<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:\s|\/?>|$)/i;
/** Containers that lose their content to a blank line. */
const CONTAINERS = ["div", "details", "section", "center", "table", "blockquote", "p", "ul", "ol"];

const count = (text: string, pattern: RegExp) => (text.match(pattern) ?? []).length;

/** The issues of one Markdown file. `skip` is the number of leading lines (frontmatter) to ignore. */
export function lintMarkdown(source: string, file: string, skip = 0): LintIssue[] {
  const issues: LintIssue[] = [];
  const add = (line: number, level: LintIssue["level"], rule: string, message: string) =>
    issues.push({ file, line: line + 1, level, rule, message });

  const all = lines(source).slice(skip);
  // The end condition of the HTML block the scan is in, if any.
  let block: { end: "blank" | "comment" | "raw"; tag?: string } | null = null;
  for (let at = 0; at < all.length; at++) {
    const line = all[at]!;
    if (line.code) {
      block = null;
      continue;
    }
    const text = line.text;
    const blank = text.trim() === "";

    if (block) {
      if (block.end === "blank" && blank) block = null;
      else if (block.end === "comment" && text.includes("-->")) block = null;
      else if (block.end === "raw" && block.tag && new RegExp(`</${block.tag}>`, "i").test(text))
        block = null;
      continue;
    }
    if (blank) continue;

    // HTML blocks: their content is not parsed as Markdown, and the inline rules do not apply in them.
    if (/^ {0,3}<!--/.test(text)) {
      if (!text.includes("-->")) block = { end: "comment" };
      continue;
    }
    const raw = /^ {0,3}<(pre|script|style|textarea)\b/i.exec(text);
    if (raw) {
      if (!new RegExp(`</${raw[1]}>`, "i").test(text)) block = { end: "raw", tag: raw[1]! };
      continue;
    }
    if (BLOCK_TAG.test(text)) {
      // The block runs to the first blank line; check that its containers close inside it.
      let end = at;
      while (end + 1 < all.length && all[end + 1]!.text.trim() !== "" && !all[end + 1]!.code) end++;
      const blockText = all
        .slice(at, end + 1)
        .map((l) => l.text)
        .join("\n");
      for (const tag of CONTAINERS) {
        const opens = count(blockText, new RegExp(`<${tag}(?=[\\s>])`, "gi"));
        const closes = count(blockText, new RegExp(`</${tag}\\s*>`, "gi"));
        if (opens > closes) {
          add(
            line.index,
            "warning",
            "html-block-split",
            `<${tag}> is closed by a blank line before its </${tag}>: Markdown ends an HTML block there, so the site shows the content after an empty <${tag}>. Remove the blank lines inside it, or drop the element.`,
          );
          break;
        }
      }
      at = end;
      continue;
    }
    if (/^ {0,3}<\/?[a-z][\w-]*(?:\s[^<>]*)?\/?>\s*$/i.test(text)) {
      // A complete tag alone on a line (an <img>, a <br>) starts an HTML block that a blank line ends.
      block = { end: "blank" };
      continue;
    }

    // From here the line is Markdown prose.
    const prose = withoutCode(text);
    if (/^ {0,3}\[\^[^\]\s]+\]:/.test(prose)) {
      add(
        line.index,
        "error",
        "footnote",
        "Footnotes are not rendered: the marker and the note both disappear. Put the note in the sentence, or in a callout (> [!NOTE]).",
      );
    } else if (
      /^ {0,3}\[[^\]^][^\]]*\]:\s*(?:<[^>]*>|\S+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*$/.test(
        prose,
      )
    ) {
      add(
        line.index,
        "error",
        "reference-link",
        "Reference-style links are not rendered: every link that uses this definition loses its text. Write the links inline: [text](url).",
      );
    }
    if (/^\s*(?:[-*+]|\d+[.)])\s+\[[ xX]\]\s/.test(prose)) {
      add(
        line.index,
        "warning",
        "task-list",
        "Task-list checkboxes are shown as plain list items. Use a plain list, or write the state in words.",
      );
    }
    if (DELIMITER_ROW.test(prose) && prose.includes(":")) {
      add(
        line.index,
        "warning",
        "table-alignment",
        "Column alignment (:--, :-:, --:) is not applied: every column is left-aligned.",
      );
    }
    for (const dest of destinations(text)) {
      if (dest.value.includes("${")) {
        add(
          line.index,
          "warning",
          "template-link",
          `The link "${dest.value.slice(0, 50)}" contains \${...}, which Jx runs as an expression (the address changes, or the link is lost when the expression cannot be evaluated; in the text around a link it stays as written). Write it as %24%7B...%7D.`,
        );
      }
    }
    const tags = new Set<string>();
    for (const m of prose.matchAll(INLINE)) {
      const tag = m[1]!.toLowerCase();
      if (tag !== "a" || !isLink(prose, m.index ?? 0, m[0])) {
        tags.add(tag);
        continue;
      }
      BADGE_TAIL.lastIndex = (m.index ?? 0) + m[0].length;
      const wraps = BADGE_TAIL.test(prose);
      const kind = wraps ? "a-badge" : "a-link";
      if (tags.has(kind)) continue;
      tags.add(kind);
      add(
        line.index,
        "error",
        wraps ? "html-badge" : "html-inline",
        wraps
          ? `An <a href> around an <img> in a paragraph loses its link, ${EMPTY_LINK}. Write it as Markdown: [![alt](image)](url).`
          : `An inline <a href> loses its link, ${EMPTY_LINK}. Write it as Markdown: [text](url).`,
      );
    }
    const elements = [...tags].filter((tag) => tag !== "a-link" && tag !== "a-badge");
    if (elements.length > 0) {
      add(
        line.index,
        "warning",
        "html-inline",
        `Inline ${elements.map((tag) => `<${tag}>`).join(", ")} keeps its text but loses the element (the content is moved outside it). Use Markdown (**bold**, \`code\`) or plain text.`,
      );
    }
  }
  return issues;
}

const lineCount = (text: string): number => text.replace(/^\uFEFF/, "").split(/\r?\n/).length;

/**
 * The issues of every published page under `docsDir`, in file order. A file is read when it is a
 * Markdown file that the collection does not exclude (dot and `_` names, node_modules) and that is
 * not a draft (`draft: true`, `publish: false`). Symbolic links follow the policy of section 4.1
 * (fsutil.walkFiles) with `o.repoRoot` as the repository (docsDir itself when it is not given); a
 * link that is not followed is reported by staging, not here. A page whose frontmatter is not valid
 * YAML is an error of the rule `frontmatter`. A missing folder has no issues.
 */
export function lintDocs(docsDir: string, o: { repoRoot?: string } = {}): LintIssue[] {
  const issues: LintIssue[] = [];
  const { files } = walkFiles(docsDir, { repoRoot: o.repoRoot ?? docsDir });
  for (const rel of files) {
    if (!/\.md$/i.test(rel) || isExcluded(rel)) continue;
    const source = readFileSync(join(docsDir, ...rel.split("/")), "utf8");
    let skip: number;
    try {
      // A copyright stamp above the frontmatter is moved behind it when the page is staged; read the
      // page the way the site will, and keep counting lines in the file the author sees.
      const { data, body } = parseFrontmatter(moveLeadingComment(source) ?? source, rel);
      if (!isPublished(data)) continue;
      skip = lineCount(source) - lineCount(body);
    } catch (error) {
      if (!(error instanceof FrontmatterError)) throw error;
      issues.push({
        file: rel,
        line: error.line,
        level: "error",
        rule: "frontmatter",
        message: `The frontmatter ${error.reason}: the page cannot be built. Fix the YAML between the two --- lines at the top of the file.`,
      });
      continue;
    }
    issues.push(...lintMarkdown(source, rel, Math.max(0, skip)));
  }
  return issues;
}

/**
 * `file:line message`, the file as the repository shows it: `prefix` is the Markdown folder relative
 * to the repository root, `/`-separated (`docs` unless the project keeps its documentation elsewhere;
 * "" or "." when the repository root itself is the Markdown folder, so the file is shown bare).
 */
export function formatIssue(issue: LintIssue, o: { prefix?: string } = {}): string {
  const folder = o.prefix ?? "docs";
  const where = folder === "" || folder === "." ? issue.file : `${folder}/${issue.file}`;
  return `${where}:${issue.line}  ${issue.message}`;
}
