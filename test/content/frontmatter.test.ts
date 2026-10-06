import { expect, test, vi } from "vitest";
import {
  FrontmatterError,
  MAX_FRONTMATTER,
  firstHeading,
  firstParagraph,
  inlineText,
  moveLeadingComment,
  parseFrontmatter,
} from "../../src/lib/frontmatter.js";

test("splits frontmatter from the body", () => {
  const { data, body } = parseFrontmatter(
    "---\ntitle: A page\norder: 2\ntags: [a, b]\n---\n\nBody text\n",
  );
  expect(data).toEqual({ title: "A page", order: 2, tags: ["a", "b"] });
  expect(body).toBe("\nBody text\n");
});

test("a file without frontmatter is all body", () => {
  expect(parseFrontmatter("# Title\n\ntext")).toEqual({ data: {}, body: "# Title\n\ntext" });
  expect(parseFrontmatter("---\n---\ntext").data).toEqual({});
});

test("bad YAML names the file", () => {
  expect(() => parseFrontmatter("---\ntitle: [unclosed\n---\n", "guides/a.md")).toThrow(
    /guides\/a\.md.*not valid YAML/,
  );
  expect(() => parseFrontmatter("---\n- a\n- b\n---\n", "b.md")).toThrow(/mapping/);
});

test("the first heading is found outside code fences, in ATX and setext form", () => {
  expect(firstHeading("Intro\n\n# The Title\n\ntext")).toBe("The Title");
  expect(firstHeading("```bash\n# not a heading\n```\n\n# Real `one`")).toBe("Real one");
  expect(firstHeading("Setext Title\n============\n\ntext")).toBe("Setext Title");
  expect(firstHeading("## only h2\n")).toBeNull();
  expect(firstHeading("# [Linked](x.md) title #")).toBe("Linked title");
});

test("the first paragraph skips headings, lists, tables, quotes, HTML and images", () => {
  const body =
    "# T\n\n![logo](x.png)\n\n<p align=center>x</p>\n\n> [!NOTE]\n> hi\n\n- a list\n\nThe **real** paragraph with a [link](a.md) and `code`,\nacross two lines.\n\nSecond.";
  expect(firstParagraph(body)).toBe("The real paragraph with a link and code, across two lines.");
  expect(firstParagraph("# Only a heading")).toBe("");
});

test("a long paragraph is cut at a word with an ellipsis", () => {
  const text = `${"word ".repeat(60)}end`;
  const cut = firstParagraph(text, 50);
  expect(cut.length).toBeLessThanOrEqual(50);
  expect(cut.endsWith("…")).toBe(true);
  expect(cut).not.toMatch(/\s…$/);
});

test("titles keep the characters that are text: underscores in words, stars with a space, code spans", () => {
  expect(inlineText("my_file page")).toBe("my_file page");
  expect(inlineText("erpnext_taskview")).toBe("erpnext_taskview");
  expect(inlineText("Using `Array<string>` safely")).toBe("Using Array<string> safely");
  expect(inlineText("C* and 2*3 notes")).toBe("C* and 2*3 notes");
  expect(inlineText("snake_case_name works")).toBe("snake_case_name works");
  expect(inlineText("Escaped \\_underscore\\_ and \\*star\\*")).toBe(
    "Escaped _underscore_ and *star*",
  );
  expect(inlineText("``a ` b`` code")).toBe("a ` b code");
});

test("titles lose what Markdown means as formatting", () => {
  expect(inlineText("**Bold** and _it_ and __strong__ and ~~gone~~")).toBe(
    "Bold and it and strong and gone",
  );
  expect(inlineText("[Linked](x.md) and ![img](a.png) and [ref][r]")).toBe(
    "Linked and img and ref",
  );
  expect(inlineText("<https://x.org> and <b>bold</b> &amp; more")).toBe(
    "https://x.org and bold & more",
  );
});

test("a heading written in HTML is the title too", () => {
  expect(
    firstHeading('<div align="center">\n  <img src="a.png">\n  <h1>Frappix</h1>\n</div>\n\ntext'),
  ).toBe("Frappix");
  expect(firstHeading('<h1 align="center">My <b>Project</b></h1>\n\n## Sub')).toBe("My Project");
  expect(firstHeading("```html\n<h1>in a fence</h1>\n```\n\n# Real")).toBe("Real");
});

test("bad frontmatter is a FrontmatterError with the problem and the line in the file", () => {
  const error = (() => {
    try {
      parseFrontmatter("---\ntitle: A\ntitle: B\n---\nbody", "x.md");
    } catch (caught) {
      return caught;
    }
  })() as FrontmatterError;
  expect(error).toBeInstanceOf(FrontmatterError);
  expect(error.name).toBe("FrontmatterError");
  expect(error.message).toBe("x.md: the frontmatter is not valid YAML (Map keys must be unique)");
  expect(error.reason).toBe("is not valid YAML (Map keys must be unique)");
  expect(error.line).toBe(3);
  expect(error.cause).toBeDefined();
  expect(() => parseFrontmatter("---\n- a\n---\n", "y.md")).toThrow(FrontmatterError);
});

test("a byte order mark and Windows line endings are read as frontmatter", () => {
  expect(parseFrontmatter("\uFEFF---\r\ntitle: A\r\n---\r\ntext")).toEqual({
    data: { title: "A" },
    body: "text",
  });
});

test("a date in the frontmatter stays text, as Jx reads it", () => {
  expect(parseFrontmatter("---\nupdated: 2026-10-06\n---\n").data).toEqual({
    updated: "2026-10-06",
  });
});

test("a comment above the frontmatter is moved below it, and nothing else is touched", () => {
  const stamped =
    "<!-- Copyright (c) 2026, Avunu LLC -->\n\n---\ntitle: A\norder: 2\n---\n\n# A\n\ntext\n";
  expect(moveLeadingComment(stamped)).toBe(
    "---\ntitle: A\norder: 2\n---\n\n<!-- Copyright (c) 2026, Avunu LLC -->\n\n# A\n\ntext\n",
  );
  expect(moveLeadingComment("<!-- a -->\n<!-- b -->\n---\ntitle: A\n---\nbody")).toBe(
    "---\ntitle: A\n---\n\n<!-- a -->\n<!-- b -->\n\nbody",
  );
  // No frontmatter behind the comment, or no comment: nothing to do.
  expect(moveLeadingComment("<!-- c -->\n\n# Title\n")).toBeNull();
  expect(moveLeadingComment("---\ntitle: A\n---\n<!-- c -->\n")).toBeNull();
  expect(moveLeadingComment("# Title\n")).toBeNull();
  // A multi-line comment, as the Frappe copyright hook writes it.
  expect(
    moveLeadingComment(
      "<!-- Copyright (c) 2026\nFor license information, see license.txt-->\n\n---\ntitle: B\n---\nx",
    ),
  ).toContain("---\ntitle: B\n---\n\n<!-- Copyright (c) 2026\nFor license");
});

test("moving the comment is quick on a file full of unclosed comments", () => {
  const hostile = `${"<!-- a\n".repeat(5000)}---\ntitle: x\n---\n`;
  const started = performance.now();
  expect(moveLeadingComment(hostile)).toBeNull();
  expect(performance.now() - started).toBeLessThan(2000);
});

test("a YAML warning (an unknown tag) is not printed", () => {
  const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(parseFrontmatter("---\ntitle: !custom A\nlist: [a, b]\n---\n").data).toEqual({
      title: "A",
      list: ["a", "b"],
    });
    expect(warn).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  } finally {
    warn.mockRestore();
    log.mockRestore();
  }
});

test("a key that is a list, a mapping or an alias is refused, at its line", () => {
  const cases: Array<[string, number]> = [
    ["? [a, b]\n: c", 3],
    ["{ a: 1 }: c", 3],
    ["a: &x foo\n*x : y", 4],
  ];
  for (const [key, line] of cases) {
    const attempt = () => parseFrontmatter(`---\ntitle: A\n${key}\n---\n`, "k.md");
    expect(attempt).toThrow(
      /^k\.md: the frontmatter has a key that is a list, a mapping or an alias/,
    );
    try {
      attempt();
    } catch (error) {
      expect((error as FrontmatterError).line, key).toBe(line);
    }
  }
  // Plain keys of other types are fine: Jx reads them as text.
  expect(parseFrontmatter("---\n1: one\ntrue: yes\n---\n").data).toEqual({
    "1": "one",
    true: "yes",
  });
});

test("frontmatter that would take seconds to read is refused quickly", () => {
  // 800 characters of nested braces took the parser five seconds before the key check; 80 KiB of
  // `[a][b` took a second.
  const started = performance.now();
  expect(() =>
    parseFrontmatter(`---\n${"{".repeat(400)}${"}".repeat(400)}\n---\n`, "b.md"),
  ).toThrow(FrontmatterError);
  const huge = "[a][b".repeat(16_000);
  expect(() => parseFrontmatter(`---\n${huge}\n---\n`, "h.md")).toThrow(
    /^h\.md: the frontmatter is larger than 64 KiB/,
  );
  expect(performance.now() - started).toBeLessThan(2000);
  // Just under the limit is read like any other text.
  const near = `---\nnote: ${"x".repeat(MAX_FRONTMATTER - 20)}\n---\n`;
  expect(parseFrontmatter(near).data.note).toHaveLength(MAX_FRONTMATTER - 20);
});

test("frontmatter with an alias bomb is an error, not a hang", () => {
  const level = (i: number) =>
    `l${i}: &l${i} [${Array.from({ length: 9 }, () => `*l${i - 1}`).join(", ")}]`;
  const bomb = [
    "l0: &l0 [x, x, x, x, x, x, x, x, x]",
    ...Array.from({ length: 9 }, (_, i) => level(i + 1)),
  ];
  expect(() => parseFrontmatter(`---\n${bomb.join("\n")}\n---\n`, "bomb.md")).toThrow(
    /bomb\.md: the frontmatter is not valid YAML \(Excessive alias count/,
  );
});
