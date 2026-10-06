import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  PROBLEM,
  doneRoutes,
  expectedRoutes,
  failureProblems,
  imageHint,
  isStrict,
  problemsIn,
  shellCommand,
  strictFailure,
} from "../../src/lib/strict.js";
import type { NavData } from "../../src/lib/types.js";
import { fixture, tempDir, writeTree } from "../support/index.js";

/** What the pinned Jx (5.0.0) printed on the trees of test/fixtures/canary and the root of test/fixtures/jx-root. */
const recorded = (name: string): string =>
  readFileSync(fixture("jx-output", `${name}.txt`), "utf8");

const nav = (urls: string[]): NavData => ({
  home: { label: "Home", url: "/docs/" },
  loose: [],
  sections: [],
  expandAll: true,
  pages: Object.fromEntries(
    urls.map((url) => [
      url,
      { title: url, description: "", section: "", prev: null, next: null, edit: "" },
    ]),
  ),
  flat: [],
  featured: [],
});

describe("isStrict", () => {
  // strict = !lenient && (--strict || CI=true); lenient = --lenient || DOCUSYSTEM_LENIENT=1
  const cases: Array<
    [string, { lenient?: boolean; strict?: boolean }, NodeJS.ProcessEnv, boolean]
  > = [
    ["nothing given", {}, {}, false],
    ["--strict", { strict: true }, {}, true],
    ["CI=true", {}, { CI: "true" }, true],
    ["CI=1 is not CI=true", {}, { CI: "1" }, false],
    ["CI=false", {}, { CI: "false" }, false],
    ["--lenient", { lenient: true }, {}, false],
    ["--lenient beats CI=true", { lenient: true }, { CI: "true" }, false],
    ["DOCUSYSTEM_LENIENT=1", {}, { DOCUSYSTEM_LENIENT: "1" }, false],
    ["DOCUSYSTEM_LENIENT=1 beats CI=true", {}, { DOCUSYSTEM_LENIENT: "1", CI: "true" }, false],
    ["DOCUSYSTEM_LENIENT=1 beats --strict", { strict: true }, { DOCUSYSTEM_LENIENT: "1" }, false],
    ["DOCUSYSTEM_LENIENT=0 does not count", {}, { DOCUSYSTEM_LENIENT: "0", CI: "true" }, true],
    ["--strict with CI=true", { strict: true }, { CI: "true" }, true],
    ["--strict is explicit: no CI needed", { strict: true, lenient: false }, {}, true],
  ];
  test.each(cases)("%s", (_label, options, env, expected) => {
    expect(isStrict(options, env)).toBe(expected);
  });

  test("reads process.env when no environment is given", () => {
    const before = process.env.CI;
    try {
      process.env.CI = "true";
      expect(isStrict({})).toBe(true);
      process.env.CI = "false";
      expect(isStrict({})).toBe(false);
    } finally {
      if (before === undefined) delete process.env.CI;
      else process.env.CI = before;
    }
  });
});

describe("problemsIn", () => {
  test("PROBLEM is the pattern of the record", () => {
    expect(PROBLEM.source).toBe("^(?:Content\\b|Warning:|Error)");
  });

  test("a clean build has no problems", () => {
    expect(problemsIn(recorded("clean"))).toEqual([]);
  });

  test("a broken link and a missing asset are found in the lines Jx printed for a lenient build", () => {
    expect(problemsIn(recorded("broken-warn"))).toEqual([
      'Content type "docs": entry "README" references missing asset "assets/not-there.png"',
      'Content links: "docs": "README.md" links to "guide/missing.md", which does not exist; it renders as plain text.',
    ]);
  });

  test("of Jx's failure for a strict build only the missing asset is a PROBLEM line: the exit code carries the rest", () => {
    expect(problemsIn(recorded("broken-error"))).toEqual([
      'Content type "docs": entry "README" references missing asset "assets/not-there.png"',
    ]);
  });

  test("two entries with one address are found (ids and routes)", () => {
    const found = problemsIn(recorded("duplicates"));
    expect(found).toHaveLength(2);
    expect(found[0]).toMatch(/^Content ids: /);
    expect(found[1]).toMatch(/^Content routes: /);
  });

  test("a compile error is found once, not again in the summary list", () => {
    const found = problemsIn(recorded("compile-error"));
    expect(found.filter((line) => line.startsWith("Error compiling /"))).toHaveLength(1);
    expect(found).toHaveLength(3);
  });

  test("hosting hints, progress and the summary line are not problems", () => {
    const output = [
      "Building site from /x...",
      "GitHub Pages ignores dist/_headers and serves its own Cache-Control",
      "Done: 8 routes → 48 files",
      "Build completed with 1 error(s):",
      "  - something",
    ].join("\n");
    expect(problemsIn(output)).toEqual([]);
  });

  test("every Content and Warning line is a problem, an indented one too, and the lines come back trimmed", () => {
    const output = [
      'Content validation: "docs/a" field "draft" expected boolean, got string',
      '  Content callouts: "docs": "README.md" has a [!QUESTION] callout, but "question" is not an enabled type',
      'Content type "docs": entry "README" references missing asset "x.png"',
      'Content relationships: "docs" field "next" references unknown content type "x"',
      "Warning: Referenced asset not found: /x.png",
      "Error compiling /docs: boom",
      "Done: 8 routes -> 48 files",
    ].join("\n");
    const found = problemsIn(output);
    expect(found).toHaveLength(6);
    expect(found[1]?.startsWith("Content callouts:")).toBe(true);
  });

  test("Windows line endings are handled", () => {
    expect(problemsIn("Content links: a\r\nDone: 1 routes\r\nWarning: b\r\n")).toEqual([
      "Content links: a",
      "Warning: b",
    ]);
  });

  test("words that only start like a problem word are not problems", () => {
    expect(problemsIn("Contents of the folder\nWarnings were fixed\nErrors: none")).toEqual([
      // `Errors: none` starts with Error: the record's pattern is deliberately that broad.
      "Errors: none",
    ]);
  });
});

describe("failureProblems", () => {
  test("lists the broken links that Jx prints under its failure message, one per link", () => {
    expect(failureProblems(recorded("broken-error"))).toEqual([
      'Content links: "README.md" links to "guide/missing.md", which does not exist',
    ]);
  });

  test("several links, and a stop at the first line that is not a bullet", () => {
    const output = [
      'Build failed: Content links: "docs" has 2 broken links:',
      '  - "a.md" links to "x.md", which does not exist',
      '  - "b.md" links to "y.md", which does not exist',
      "something else",
      "  - not part of the list",
    ].join("\n");
    expect(failureProblems(output)).toEqual([
      'Content links: "a.md" links to "x.md", which does not exist',
      'Content links: "b.md" links to "y.md", which does not exist',
    ]);
  });

  test("other failures list nothing", () => {
    expect(failureProblems(recorded("compile-error"))).toEqual([]);
    expect(failureProblems(recorded("clean"))).toEqual([]);
  });
});

describe("doneRoutes", () => {
  test.each([
    ["clean", 6],
    ["broken-warn", 4],
    ["duplicates", 4],
  ])("%s", (name, routes) => {
    expect(doneRoutes(recorded(name))).toBe(routes);
  });

  test("no Done line: null (also for a failed build)", () => {
    expect(doneRoutes(recorded("broken-error"))).toBeNull();
    expect(doneRoutes(recorded("compile-error"))).toBeNull();
    expect(doneRoutes("")).toBeNull();
  });

  test("the arrow and the file count are not needed, and one route is singular", () => {
    expect(doneRoutes("Done: 12 routes")).toBe(12);
    expect(doneRoutes("Done: 1 route -> 3 files")).toBe(1);
    expect(doneRoutes("  Done: 3 routes")).toBeNull(); // the line starts at the margin
    expect(doneRoutes("Not Done: 3 routes")).toBeNull();
  });
});

describe("expectedRoutes", () => {
  test("the nav's pages plus the static pages of the root (7 = 5 + 2)", () => {
    const root = writeTree(tempDir(), {
      "pages/index.json": "{}",
      "pages/404.json": "{}",
      "pages/[...path].json": "{}",
    });
    expect(
      expectedRoutes(nav(["/docs/", "/docs/a/", "/docs/b/", "/docs/c/", "/docs/d/"]), root),
    ).toBe(7);
  });

  test("dynamic pages, underscore names, other extensions and folders are handled as Jx does", () => {
    const root = writeTree(tempDir(), {
      "pages/index.json": "{}",
      "pages/about.json": "{}",
      "pages/blog/index.json": "{}",
      "pages/blog/[slug].json": "{}",
      "pages/[category]/index.json": "{}",
      "pages/_partial.json": "{}",
      "pages/_private/page.json": "{}",
      "pages/readme.txt": "text",
      "pages/blog/notes.md": "# not a page of Jx's native format",
    });
    // index, about, blog/index = 3; the [category] folder, [slug], _partial and _private are not static pages
    expect(expectedRoutes(nav([]), root)).toBe(3);
  });

  test("no pages folder: only the nav counts", () => {
    expect(expectedRoutes(nav(["/docs/"]), tempDir())).toBe(1);
  });
});

describe("messages", () => {
  test("the strict failure names the count and the way out", () => {
    expect(strictFailure(3)).toBe(
      "docusystem: 3 document problem(s) above fail the build. Fix the documents, or run with --lenient while you work through them.",
    );
  });

  test("the image hint appears for sharp and libstdc++ only", () => {
    expect(imageHint("Error: Could not load the sharp module")).toContain('"images": "off"');
    expect(imageHint("libstdc++.so.6: cannot open shared object file")).toContain("sharp");
    expect(imageHint(recorded("compile-error"))).toBeNull();
  });

  test("shellCommand quotes what a shell would split", () => {
    expect(shellCommand(["/usr/bin/node", "/a/jx.js", "build", "/b/site"])).toBe(
      "/usr/bin/node /a/jx.js build /b/site",
    );
    expect(shellCommand(["/usr/bin/node", "/a b/jx.js", "it's"])).toBe(
      "/usr/bin/node '/a b/jx.js' 'it'\\''s'",
    );
  });

  // cmd.exe has no single quotes and a backslash is not a shell character there: every path of a Windows
  // machine used to be printed as '<path>', which neither cmd.exe nor PowerShell can run.
  test("shellCommand writes a Windows path as the word it is, and double-quotes what a Windows shell would split", () => {
    const node = "C:\\hostedtoolcache\\windows\\node\\24.21.0\\x64\\node.exe";
    const root = "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\docs-site\\.docusystem\\site";
    expect(shellCommand([node, "/fake/jx/bin/jx.js", "build", root], "win32")).toBe(
      `${node} /fake/jx/bin/jx.js build ${root}`,
    );
    expect(
      shellCommand(
        [
          "C:\\Program Files\\nodejs\\node.exe",
          "C:\\a\\node_modules\\@jxsuite\\compiler\\jx.js",
          'say "hi"',
          "50%",
        ],
        "win32",
      ),
    ).toBe(
      '"C:\\Program Files\\nodejs\\node.exe" "C:\\a\\node_modules\\@jxsuite\\compiler\\jx.js" "say \\"hi\\"" "50%"',
    );
    // The POSIX rules do not depend on where they are asked for: a backslash is a shell character there.
    expect(shellCommand(["C:\\a\\b.exe"], "linux")).toBe("'C:\\a\\b.exe'");
    expect(shellCommand(["/usr/bin/node", "/a b/jx.js"], "darwin")).toBe(
      "/usr/bin/node '/a b/jx.js'",
    );
  });
});
