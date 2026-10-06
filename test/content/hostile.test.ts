// A pull request can put any text into docs/, and the build job reads all of it. These inputs are
// the ones that made the prototype's scanners take quadratic or cubic time (thousands of `](` that
// never close, a run of backticks, an unterminated tag repeated, a line of spaces); each is a single
// line of 60 to 100 KB. A scanner that is linear takes tens of milliseconds on them; the limit below
// is generous (a slow runner) and far below what the quadratic ones needed (minutes).
import { describe, expect, test } from "vitest";
import { firstHeading, firstParagraph, inlineText } from "../../src/lib/frontmatter.js";
import { lintMarkdown } from "../../src/lib/lint.js";
import { destinations, lines, withoutCode } from "../../src/lib/markdown.js";
import { humanize, slugifyPath } from "../../src/lib/slug.js";
import { stageMarkdown, type StageOptions } from "../../src/lib/stage.js";

const N = 6_000;

const INPUTS: Record<string, string> = {
  "open brackets": "[".repeat(N * 5),
  "unclosed links": "[a](b".repeat(N),
  "unclosed images": "![a](".repeat(N),
  "unclosed template links": "[x](${".repeat(N),
  "unclosed badges": "[![a](b)](c".repeat(N / 2),
  "unclosed angle destinations": "[a](<b ".repeat(N),
  "unclosed titles": '[a](b "'.repeat(N),
  "one long run of backticks": "`".repeat(N * 5),
  "backtick pairs": "`a".repeat(N * 2),
  "unterminated anchors": "<a ".repeat(N),
  "unterminated kbd": "<kbd ".repeat(N),
  "unterminated autolinks": "<https://".repeat(N),
  "stars with words": "*a ".repeat(N),
  underscores: "_a".repeat(N),
  "strikethrough openers": "~~a ".repeat(N),
  "reference openers": "[a][b".repeat(N),
  "spaces and a letter": `${" ".repeat(N * 5)}x`,
  "table delimiter and spaces": `|:--|${" ".repeat(N * 5)}x`,
  "heading of spaces": `#${" ".repeat(N * 5)}x`,
  "heading of hashes": `# a${" #".repeat(N * 2)} x`,
};

const options: StageOptions = {
  source: "/nonexistent/docs",
  dest: "/nonexistent/out",
  repoRoot: "/nonexistent",
  repoUrl: "https://github.com/Avunu/docusystem-example",
  branch: "main",
};

/** Every scanner of the content modules, applied to one line of text. */
const SCANNERS: Record<string, (text: string) => unknown> = {
  lintMarkdown: (text) => lintMarkdown(text, "a.md"),
  stageMarkdown: (text) => stageMarkdown(text, "a.md", options),
  destinations: (text) => destinations(text),
  withoutCode: (text) => withoutCode(text),
  lines: (text) => lines(text),
  inlineText: (text) => inlineText(text),
  firstHeading: (text) => firstHeading(text),
  firstParagraph: (text) => firstParagraph(text),
  slugifyPath: (text) => slugifyPath(text),
  humanize: (text) => humanize(text),
};

describe("hostile single lines are read in time proportional to their length", () => {
  for (const [name, text] of Object.entries(INPUTS)) {
    test(`${name} (${Math.round(text.length / 1000)} KB)`, () => {
      for (const [scanner, scan] of Object.entries(SCANNERS)) {
        const started = performance.now();
        scan(text);
        const took = performance.now() - started;
        expect(took, `${scanner} took ${took.toFixed(0)} ms`).toBeLessThan(3000);
      }
    });
  }
});

test("a link destination of more than 2,000 characters is not read, a long one is", () => {
  const long = `${"a/".repeat(900)}b.md`; // 1,800 characters
  expect(destinations(`[x](${long})`).map((d) => d.value)).toEqual([long]);
  expect(destinations(`[x](${long}${long}.md)`)).toEqual([]);
  // A data: address (a base64 image) is not a link to anything and is allowed to go unread.
  expect(destinations(`![x](data:image/png;base64,${"A".repeat(10_000)})`)).toEqual([]);
});

test("the plain text of a long title or paragraph is cut, not refused", () => {
  const word = "word ";
  expect(inlineText(word.repeat(5000)).length).toBeLessThanOrEqual(4000);
  expect(firstParagraph(word.repeat(5000), 50).length).toBeLessThanOrEqual(50);
  expect(firstHeading(`# ${word.repeat(5000)}`)).toMatch(/^word word/);
});

test("a table delimiter row is still found, with any spacing, and a long run of spaces is not one", () => {
  const warns = (text: string) =>
    lintMarkdown(text, "a.md")
      .map((i) => i.rule)
      .includes("table-alignment");
  expect(warns("|:--|--:|")).toBe(true);
  expect(warns("| :-- | :--: | --: |")).toBe(true);
  expect(warns("  :--  ")).toBe(true);
  expect(warns("|--|--|")).toBe(false); // no alignment colon: nothing to warn about
  expect(warns("| a | b |")).toBe(false);
  expect(warns(`|:--|${" ".repeat(50_000)}x`)).toBe(false);
});
