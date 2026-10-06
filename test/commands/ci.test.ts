import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  annotation,
  appendStepOutputs,
  appendStepSummary,
  renderSummary,
  runtimeName,
  type SummaryInput,
} from "../../src/lib/ci.js";
import { at, tempDir } from "../support/index.js";

describe("annotation", () => {
  // The byte-for-byte contract of section 4.1: `::error file=docs/x.md,line=N,title=<stage>::message`.
  test("an error with a location and a stage", () => {
    expect(annotation("error", "Footnotes are not rendered.", "docs/guide/x.md", 15, "lint")).toBe(
      "::error file=docs/guide/x.md,line=15,title=lint::Footnotes are not rendered.",
    );
  });

  test("a warning", () => {
    expect(annotation("warning", "A task list.", "docs/x.md", 8, "lint")).toBe(
      "::warning file=docs/x.md,line=8,title=lint::A task list.",
    );
  });

  test("without a line, without a file, without a stage", () => {
    expect(annotation("error", "m", "docs/x.md", undefined, "stage")).toBe(
      "::error file=docs/x.md,title=stage::m",
    );
    expect(annotation("error", "m", undefined, undefined, "jx")).toBe("::error title=jx::m");
    expect(annotation("error", "m")).toBe("::error::m");
    expect(annotation("warning", "m", "docs/x.md")).toBe("::warning file=docs/x.md::m");
  });

  test("a line without a file cannot be placed and is left out", () => {
    expect(annotation("error", "m", undefined, 3, "lint")).toBe("::error title=lint::m");
  });

  test("a line number of zero is left out", () => {
    expect(annotation("error", "m", "docs/x.md", 0, "lint")).toBe(
      "::error file=docs/x.md,title=lint::m",
    );
  });

  test("line breaks in the message are %0A, carriage returns %0D, and a percent sign is %25", () => {
    expect(annotation("error", "one\ntwo\r\n100%", "docs/x.md", 1, "jx")).toBe(
      "::error file=docs/x.md,line=1,title=jx::one%0Atwo%0D%0A100%25",
    );
  });

  test("a colon or a comma in a property is escaped, in the message it is not", () => {
    expect(annotation("error", "a: b, c", "docs/a,b:c.md", 2, "x:y")).toBe(
      "::error file=docs/a%2Cb%3Ac.md,line=2,title=x%3Ay::a: b, c",
    );
  });
});

describe("the files of GitHub Actions", () => {
  test("the job summary is appended, with a final newline", () => {
    const file = at(tempDir(), "summary.md");
    writeFileSync(file, "earlier\n");
    expect(appendStepSummary({ GITHUB_STEP_SUMMARY: file }, "### Title")).toBe(true);
    expect(appendStepSummary({ GITHUB_STEP_SUMMARY: file }, "more\n")).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("earlier\n### Title\nmore\n");
  });

  test("outside GitHub Actions nothing is written and false says so", () => {
    expect(appendStepSummary({}, "x")).toBe(false);
    expect(appendStepSummary({ GITHUB_STEP_SUMMARY: "" }, "x")).toBe(false);
    expect(appendStepOutputs({}, { dist: "/x" })).toBe(false);
  });

  test("step outputs are name=value lines", () => {
    const file = join(tempDir(), "output");
    expect(
      appendStepOutputs(
        { GITHUB_OUTPUT: file },
        { dist: "/work/docs-site/dist", "page-url": "https://x.avunu.net/", pages: "7" },
      ),
    ).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(
      "dist=/work/docs-site/dist\npage-url=https://x.avunu.net/\npages=7\n",
    );
  });

  test("a value with a line break is refused: it would write a second output", () => {
    const file = join(tempDir(), "output");
    expect(() => appendStepOutputs({ GITHUB_OUTPUT: file }, { dist: "a\nb=c" })).toThrow(
      /line break/,
    );
  });
});

describe("renderSummary", () => {
  const base: SummaryInput = {
    passed: true,
    domain: "example.avunu.net",
    steps: [
      { name: "Build", ok: true, detail: "7 page(s) written" },
      { name: "Contrast", ok: true, detail: "148 color pair(s), 0 below the minimum" },
    ],
    versions: {
      docusystem: "0.1.0",
      runtime: "node 24.21.0",
      jx: { "@jxsuite/compiler": "5.0.0", "@jxsuite/parser": "2.0.0" },
    },
    catalog: "bundled",
    overrides: { shadowed: [], added: [] },
    problems: [],
  };

  test("a passing run", () => {
    expect(renderSummary(base)).toBe(
      [
        "### Documentation check: passed",
        "",
        "| Step | Result |",
        "| --- | --- |",
        "| Build | ok: 7 page(s) written |",
        "| Contrast | ok: 148 color pair(s), 0 below the minimum |",
        "",
        "The site is published at https://example.avunu.net/ once it is deployed.",
        "",
        "#### Build",
        "",
        "- @avunu/docusystem 0.1.0, node 24.21.0",
        "- @jxsuite/compiler 5.0.0, @jxsuite/parser 2.0.0",
        "- project catalog: bundled",
        "- overrides: none",
        "",
      ].join("\n"),
    );
  });

  test("a failed run lists its problems, the essentials and the overrides", () => {
    const text = renderSummary({
      ...base,
      passed: false,
      steps: [{ name: "Build", ok: false, detail: "1 error(s) | nothing was published" }],
      overrides: { shadowed: ["components/docs-footer.json"], added: ["pages/about.json"] },
      problems: [
        { level: "error", message: "Footnotes are not rendered.", file: "docs/a.md", line: 3 },
        { level: "error", message: 'Content links: "a.md" links to "b.md"' },
        { level: "warning", message: "A task list.", file: "docs/b.md", line: 8 },
      ],
    });
    expect(text).toContain("### Documentation check: failed");
    expect(text).toContain("| Build | FAILED: 1 error(s) \\| nothing was published |");
    expect(text).toContain("#### Problems: 2 error(s), 1 warning(s)");
    expect(text).toContain("error: docs/a.md:3  Footnotes are not rendered.");
    expect(text).toContain('error: Content links: "a.md" links to "b.md"');
    expect(text).toContain("warning: docs/b.md:8  A task list.");
    expect(text).toContain(
      "- overrides: components/docs-footer.json (replaces the package's file), pages/about.json (added)",
    );
  });

  test("the jx setting is an override: it is listed, alone or after files, and 'none' is not claimed", () => {
    const jx = 'the "jx" setting of docusystem.config.json (merged into project.json)';
    expect(renderSummary({ ...base, overrides: { shadowed: [], added: [], jx: true } })).toContain(
      `- overrides: ${jx}\n`,
    );
    expect(
      renderSummary({
        ...base,
        overrides: { shadowed: [], added: ["pages/about.json"], jx: true },
      }),
    ).toContain(`- overrides: pages/about.json (added), ${jx}\n`);
    expect(renderSummary({ ...base, overrides: { shadowed: [], added: [], jx: false } })).toContain(
      "- overrides: none\n",
    );
  });

  test("at most twenty problems are listed, and the rest is counted", () => {
    const problems = Array.from({ length: 25 }, (_, i) => ({
      level: "error" as const,
      message: `problem ${i}`,
    }));
    const text = renderSummary({ ...base, passed: false, problems });
    expect(text).toContain("error: problem 19");
    expect(text).not.toContain("error: problem 20");
    expect(text).toContain("... and 5 more (see the log)");
  });

  test("a message cannot close the code block", () => {
    const text = renderSummary({
      ...base,
      problems: [{ level: "error", message: "text ``` more" }],
    });
    expect(text.match(/```/g)).toHaveLength(2);
  });

  test("the domain line and the build section are optional", () => {
    const { domain: _domain, catalog: _catalog, overrides: _overrides, ...rest } = base;
    const text = renderSummary(rest);
    expect(text).not.toContain("published at");
    expect(text).not.toContain("project catalog");
    expect(text).not.toContain("overrides");
  });
});

describe("runtimeName", () => {
  test("names the runtime and its version", () => {
    expect(runtimeName()).toMatch(/^(node|bun) \d+\.\d+\.\d+/);
  });
});
