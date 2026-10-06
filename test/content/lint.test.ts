import { expect, test } from "vitest";
import { formatIssue, lintDocs, lintMarkdown } from "../../src/lib/lint.js";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { tempDir, writeTree } from "../support/index.js";
import { makeTree, symlinksWork } from "./helpers.js";

const rules = (source: string) =>
  lintMarkdown(source, "a.md").map((i) => `${i.level}:${i.rule}@${i.line}`);

test("ordinary Markdown has nothing to report", () => {
  expect(
    rules(
      [
        "# Title",
        "",
        "Text with **bold**, `code`, a [link](a.md), an ![image](b.png) and <https://example.com>.",
        "",
        "- a list",
        "  - nested",
        "",
        "| a | b |",
        "|---|---|",
        "| 1 | 2 |",
        "",
        "> [!NOTE]",
        "> A callout with <br> a break and an <img src=x.png> image.",
        "",
        "```html",
        "<kbd>Ctrl</kbd> in code is fine, and [ref]: not a definition",
        "```",
        "",
        '<p align="center">',
        '  <a href="https://x.org"><img src="b.svg"></a>',
        "</p>",
      ].join("\n"),
    ),
  ).toEqual([]);
});

test("reference-style link definitions and footnotes are errors: the text of the links vanishes", () => {
  expect(rules("See [the docs][d].\n\n[d]: https://example.com/docs")).toEqual([
    "error:reference-link@3",
  ]);
  expect(rules("Text[^1].\n\n[^1]: The note.")).toEqual(["error:footnote@3"]);
  expect(rules('[d]: <https://example.com/a b> "A title"\n[e]: https://example.com')).toEqual([
    "error:reference-link@1",
    "error:reference-link@2",
  ]);
  // Square brackets that are not definitions are text: a definition has one address and an optional title.
  expect(rules("[Note]: this is important\n\n[Warning]: do not")).toEqual([]);
  // Square brackets that are not definitions are text.
  expect(rules("array[0][1] and [x] and a [^caret] mention")).toEqual([]);
  expect(rules("`[d]: https://example.com`")).toEqual([]);
});

test("inline HTML elements warn: the text stays, the element is lost", () => {
  expect(rules("Press <kbd>Ctrl</kbd>+<kbd>C</kbd> and <sub>2</sub>.")).toEqual([
    "warning:html-inline@1",
  ]);
  // An email autolink is not an <a> element.
  expect(rules("Mail <a@b.com> or visit <https://x.org>.")).toEqual([]);
});

test("an <a href> in a paragraph is an error: Jx leaves an empty link and the empty-link assertion fails every build", () => {
  const link = lintMarkdown("A <a href='https://x.org'>link</a> in a sentence.", "a.md");
  expect(link.map((i) => `${i.level}:${i.rule}@${i.line}`)).toEqual(["error:html-inline@1"]);
  expect(link[0]!.message).toContain("[text](url)");
  expect(link[0]!.message).toContain("which fails the build in every mode, --lenient included");

  // A badge: the same level and the same reason, and the Markdown form to write instead.
  const badge = lintMarkdown('A <a href="https://x.org"><img src="b.svg"></a> badge.', "a.md");
  expect(badge.map((i) => `${i.level}:${i.rule}@${i.line}`)).toEqual(["error:html-badge@1"]);
  expect(badge[0]!.message).toContain("[![alt](image)](url)");
  expect(badge[0]!.message).toContain("which fails the build in every mode, --lenient included");

  // On the line of the badge, wherever it is in the page, and once per kind per line.
  expect(
    rules(
      [
        "Intro.",
        "",
        'Text <a href="https://x.org/1"><img src="1.svg"></a> <a href="https://x.org/2"><img src="2.svg"></a>',
        "and <a href=a>one</a> and <a href=b>two</a>.",
      ].join("\n"),
    ),
  ).toEqual(["error:html-badge@3", "error:html-inline@4"]);

  // Attribute spellings and quoted values: an href is found whatever the case and the order, and a
  // quoted value that holds a ">" or the word href is not an attribute.
  expect(rules('<A CLASS="x" HREF="https://x.org">link</A>')).toEqual(["error:html-inline@1"]);
  expect(rules('<a title="a > b" href="https://x.org">link</a>')).toEqual(["error:html-inline@1"]);
  expect(rules("<a href>link</a>")).toEqual(["error:html-inline@1"]);
  expect(rules('<a title="see href=x" name="top">anchor</a>')).toEqual(["warning:html-inline@1"]);
});

test("an <a> without an href is an anchor, not a link: Jx keeps it, so it only warns", () => {
  expect(rules('Jump <a id="top"></a> and <a name="x">there</a>.')).toEqual([
    "warning:html-inline@1",
  ]);
  const [issue] = lintMarkdown('<a name="x">there</a>', "a.md");
  expect(issue!.message).toContain("<a>");
  expect(issue!.message).not.toContain("every mode");
  // An <a name> around an image is not a badge: nothing is left empty.
  expect(rules('<a name="x"><img src="b.svg"></a>')).toEqual(["warning:html-inline@1"]);
});

test("an HTML block that a blank line ends before its closing tag warns", () => {
  expect(rules('<div align="center">\n\n# Title\n\n</div>\n')).toEqual([
    "warning:html-block-split@1",
  ]);
  expect(rules("<details>\n<summary>More</summary>\n\nHidden **text**.\n\n</details>\n")).toEqual([
    "warning:html-block-split@1",
  ]);
  // Closed inside the block: fine.
  expect(rules("<details>\n<summary>More</summary>\nHidden text.\n</details>\n")).toEqual([]);
  expect(rules('<p align="center">\n  <img src="a.png">\n</p>\n')).toEqual([]);
});

test("task lists and table alignment warn", () => {
  expect(rules("- [x] done\n- [ ] open")).toEqual(["warning:task-list@1", "warning:task-list@2"]);
  expect(rules("| a | b |\n|:--|--:|\n| 1 | 2 |")).toEqual(["warning:table-alignment@2"]);
});

// Jx evaluates a `${...}` in anything that becomes an attribute (a link or image address, an autolink,
// a URL, a tag, a directive, the language of a fence), as JavaScript, when the site is built. Staging
// writes it inert (inert.ts), so nothing runs, but the link is then not what the page says: an error,
// like the other constructs that lose what was written.
test("a `${...}` where it would become an attribute is an error, in every place that can hold one", () => {
  const live = [
    "[x](https://x.org/${HOME})",
    "![x](https://x.org/${HOME}.png)",
    "[x](<https://x.org/${HOME}>)",
    "<https://x.org/${HOME}>",
    "A bare address https://x.org/${HOME} in a sentence.",
    "A bare address www.x.org/${HOME} in a sentence.",
    '<img src="${HOME}" alt="x">',
    '<div data-a="${HOME}">text</div>',
    ":::note{class='${HOME}'}\ntext\n:::",
    "- [x](https://x.org/${HOME})",
    "> [x](https://x.org/${HOME})",
    "| [x](https://x.org/${HOME}) | b |",
    "## [x](https://x.org/${HOME})",
    "[x](https://x.org/&#36;{HOME})",
    "[x](https://x.org/$\\{HOME})",
    "[x](https://x.org/&dollar;&lbrace;HOME})",
    "```${HOME}\ncode\n```",
    "~~~js ${HOME}\ncode\n~~~",
  ];
  for (const source of live) {
    expect(rules(source), source).toContain("error:template-expression@1");
  }
});

test("a `${...}` in prose, a code span or a code block is text, and is not reported", () => {
  for (const source of [
    "Set ${HOME} first.",
    "Set `${HOME}` first.",
    "A [link with `${HOME}` in its text](a.md).",
    "```bash\necho ${HOME} and ${{ secrets.TOKEN }}\n```",
    "1. A step:\n\n   ```yaml\n   run: echo ${{ github.sha }}\n   ```",
    "> [!TIP]\n> ```bash\n> export HOME_COPY=${HOME}\n> ```",
    "| Variable | Meaning |\n| --- | --- |\n| `${HOME}` | Home folder |",
    "[x](https://x.org/%24%7BHOME%7D)",
  ]) {
    expect(rules(source), source).toEqual([]);
  }
});

test("the message says what happens to the text and what to write instead", () => {
  const [issue] = lintMarkdown("[x](https://x.org/${HOME})", "a.md");
  expect(issue).toMatchObject({ level: "error", rule: "template-expression", line: 1 });
  expect(issue!.message).toContain("zero-width space");
  expect(issue!.message).toContain("%24%7B...%7D");
  expect(issue!.message).toContain("code span");
});

test("HTML comments, pre blocks and fences hide their content from the inline rules", () => {
  expect(rules("<!-- <kbd>x</kbd>\n[a]: b\n-->\n\ntext")).toEqual([]);
  expect(rules("<pre>\n<kbd>x</kbd>\n</pre>\n")).toEqual([]);
  expect(rules("```\n[a]: b\n- [x] t\n```\n")).toEqual([]);
});

test("lintDocs skips frontmatter, drafts and excluded files, and reports file and line", () => {
  const root = makeTree({
    "README.md":
      "---\ntitle: 'Home'\ndescription: '[x]: not a definition'\n---\n\nText <kbd>x</kbd>\n",
    "guides/a.md": "# A\n\n[r]: https://example.com\n",
    "wip.md": "---\ndraft: true\n---\n\n[r]: https://example.com\n",
    "hidden-from-site.md": "---\npublish: false\n---\n\n[r]: https://example.com\n",
    "_private.md": "[r]: https://example.com\n",
    ".obsidian/notes.md": "[r]: https://example.com\n",
    "node_modules/x/README.md": "[r]: https://example.com\n",
    "notes.txt": "[r]: https://example.com\n",
  });
  const issues = lintDocs(root);
  expect(issues.map((i) => `${i.file}:${i.line}:${i.rule}`)).toEqual([
    "README.md:6:html-inline",
    "guides/a.md:3:reference-link",
  ]);
  expect(formatIssue(issues[1]!)).toMatch(/^docs\/guides\/a\.md:3 {2}Reference-style links/);
});

test("formatIssue names the Markdown folder when it is not docs/", () => {
  const issue = { file: "a.md", line: 2, level: "error", rule: "footnote", message: "m" } as const;
  expect(formatIssue(issue)).toBe("docs/a.md:2  m");
  expect(formatIssue(issue, { prefix: "documentation" })).toBe("documentation/a.md:2  m");
  expect(formatIssue(issue, { prefix: "guide/book" })).toBe("guide/book/a.md:2  m");
});

test("formatIssue shows the bare file when the repository root is the Markdown folder", () => {
  const issue = { file: "a.md", line: 2, level: "error", rule: "footnote", message: "m" } as const;
  expect(formatIssue(issue, { prefix: "" })).toBe("a.md:2  m");
  expect(formatIssue(issue, { prefix: "." })).toBe("a.md:2  m");
});

test("a page whose frontmatter is not valid YAML is an error at the line of the problem", () => {
  const root = makeTree({
    "README.md": "# Home\n",
    "broken.md": "---\ntitle: A\ntitle: B\n---\n[r]: https://example.com\n",
    "list.md": "---\n- a\n- b\n---\ntext\n",
    "z.md": "# Z\n\n[r]: https://example.com\n",
  });
  const issues = lintDocs(root);
  expect(issues.map((i) => `${i.file}:${i.line}:${i.level}:${i.rule}`)).toEqual([
    "broken.md:3:error:frontmatter",
    "list.md:1:error:frontmatter",
    "z.md:3:error:reference-link",
  ]);
  expect(issues[0]!.message).toBe(
    "The frontmatter is not valid YAML (Map keys must be unique): the page cannot be built. Fix the YAML between the two --- lines at the top of the file.",
  );
  expect(issues[1]!.message).toContain("must be a YAML mapping");
});

test("a copyright stamp above the frontmatter does not hide the page's own status or shift its lines", () => {
  const stamp = "<!-- Copyright (c) 2026, Avunu LLC -->\n\n";
  const root = makeTree({
    "draft.md": `${stamp}---\ndraft: true\n---\n\n[r]: https://example.com\n`,
    "live.md": `${stamp}---\ntitle: Live\ntags: [a, b]\n---\n\nText\n\n[r]: https://example.com\n`,
  });
  expect(lintDocs(root).map((i) => `${i.file}:${i.line}:${i.rule}`)).toEqual([
    "live.md:10:reference-link",
  ]);
});

test("a page with a leading BOM and CRLF line endings reports the line the author sees", () => {
  const root = makeTree({
    "a.md": "\uFEFF---\r\ntitle: A\r\n---\r\n\r\n[r]: https://example.com\r\n",
  });
  expect(lintDocs(root).map((i) => `${i.line}:${i.rule}`)).toEqual(["5:reference-link"]);
});

test("a missing docs folder has no issues", () => {
  expect(lintDocs(join(makeTree({}), "nope"))).toEqual([]);
});

test.skipIf(!symlinksWork)(
  "links follow the symlink policy: inside the repository is read, outside is not, a cycle ends",
  () => {
    const base = tempDir("docusystem-lint-");
    writeTree(base, {
      "outside/secret.md": "[r]: https://example.com\n",
      "repo/docs/README.md": "# Home\n",
      "repo/shared/note.md": "[r]: https://example.com\n",
    });
    const docs = join(base, "repo", "docs");
    symlinkSync(join(base, "repo", "shared"), join(docs, "guides"));
    symlinkSync(join(base, "outside", "secret.md"), join(docs, "leak.md"));
    symlinkSync(docs, join(docs, "loop"));
    const issues = lintDocs(docs, { repoRoot: join(base, "repo") });
    expect(issues.map((i) => `${i.file}:${i.rule}`)).toEqual(["guides/note.md:reference-link"]);
    // Without a repository root the docs folder itself is the boundary.
    expect(lintDocs(docs)).toEqual([]);
  },
);
