// site/ is the starter's template (Avunu/docs, Sites/project-docs-starter/template at commit 1820d01,
// the commit the three pilots copied) with exactly the four changes of section 10.3, the two fixes
// that came after (the scrollable region and the escaped <title>) and nothing else.
// fixtures/starter-1820d01.json records the sha256 of every file of that template; these tests list
// the differences against it and prove that each one is exactly its change by undoing it.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { sha256 } from "../../src/lib/fsutil.js";
import { SITE, SITE_FIXTURES, exists, readText, siteFiles } from "./support/site.js";

const starter = JSON.parse(readFileSync(join(SITE_FIXTURES, "starter-1820d01.json"), "utf8")) as {
  commit: string;
  files: Record<string, string>;
};

/** The starter's `project.json` is `project.base.json` here; its `public/CNAME` is generated. */
const RENAMED: Record<string, string> = { "project.json": "project.base.json" };
const NOT_SHIPPED = ["public/CNAME"];

const shippedName = (starterPath: string): string => RENAMED[starterPath] ?? starterPath;

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

interface Change {
  occurrences: number;
  from: string;
  to: string;
}

/** The changes, each as a function from this package's file to the starter's file. */
const UNDO: Record<string, Change & { why: string; and?: Change[] }> = {
  "layouts/base.json": {
    why: "the resolved config is docusystem.config.json (the id, which names the file, and the description)",
    occurrences: 2,
    from: "docusystem.config",
    to: "docs.config",
  },
  "pages/index.json": {
    why: "the landing page reads docusystem.config.json (its description)",
    occurrences: 1,
    from: "docusystem.config",
    to: "docs.config",
  },
  "project.base.json": {
    why: "the config content type's source is docusystem.config.json",
    occurrences: 1,
    from: '"source": "./docusystem.config.json"',
    to: '"source": "./docs.config.json"',
  },
  "pages/[...path].json": {
    why: "the edit-this-page URL reads the docs folder from the config instead of the literal docs, and the <title> is written escaped (headTitle: Jx writes that one element as it is)",
    occurrences: 1,
    from: "(c.docsPath || 'docs')",
    to: "'docs'",
    and: [
      { occurrences: 1, from: '"title": "${state.headTitle}"', to: '"title": "${state.pageTitle}"' },
      {
        occurrences: 1,
        from: [
          '    "headTitle": {',
          '      "$prototype": "Function",',
          '      "timing": "compiler",',
          `      "body": "return String(state.pageTitle).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');"`,
          "    },",
          "",
        ].join("\n"),
        to: "",
      },
      {
        occurrences: 1,
        from: "The <title> is the one place Jx writes text as it is (every attribute and text node it escapes itself), so the page hands it the title already escaped (headTitle): a title that holds `</title>` stays text instead of ending the element. ",
        to: "",
      },
    ],
  },
  "components/docs-enhance.json": {
    why: "the scrollable-region fix: a region that overflows by one pixel is focusable too",
    occurrences: 1,
    from: "el.scrollWidth > el.clientWidth) {",
    to: "el.scrollWidth > el.clientWidth + 1) {",
  },
};

describe("site/ against the starter template of commit 1820d01", () => {
  test("the record is of the commit the pilots copied and lists every kind of file", () => {
    expect(starter.commit).toBe("1820d01ccbd2a6a299f6f673381a2272a06c64dc");
    const folders = new Set(Object.keys(starter.files).map((f) => f.split("/")[0]));
    expect([...folders].sort()).toEqual([
      "components",
      "layouts",
      "pages",
      "project.json",
      "public",
    ]);
    expect(Object.keys(starter.files)).toHaveLength(32);
  });

  test("site/ ships every file of the template except the generated CNAME, and no other file", () => {
    const expected = Object.keys(starter.files)
      .filter((file) => !NOT_SHIPPED.includes(file))
      .map(shippedName)
      .sort();
    expect(siteFiles()).toEqual(expected);
  });

  test("public/CNAME is not shipped: it is generated from the configured domain", () => {
    expect(exists("public/CNAME")).toBe(false);
  });

  test("the files that differ from the template are exactly the five that carry the changes", () => {
    const differing = Object.entries(starter.files)
      .filter(([file]) => !NOT_SHIPPED.includes(file))
      .filter(([file, hash]) => sha256(join(SITE, shippedName(file))) !== hash)
      .map(([file]) => shippedName(file))
      .sort();
    expect(differing).toEqual(Object.keys(UNDO).sort());
  });

  for (const [file, undo] of Object.entries(UNDO)) {
    test(`${file}: ${undo.why}, and nothing else`, () => {
      let original = readText(file);
      for (const change of [undo, ...(undo.and ?? [])]) {
        expect(original.split(change.from)).toHaveLength(change.occurrences + 1);
        original = original.split(change.from).join(change.to);
      }
      const starterFile = Object.keys(starter.files).find((f) => shippedName(f) === file)!;
      expect(sha(original)).toBe(starter.files[starterFile]);
    });
  }

  test("every other file is byte-for-byte the template's (fonts, marks, favicons, components, layouts)", () => {
    const changed = new Set(Object.keys(UNDO));
    for (const [file, hash] of Object.entries(starter.files)) {
      if (NOT_SHIPPED.includes(file) || changed.has(shippedName(file))) continue;
      expect(sha256(join(SITE, file)), file).toBe(hash);
    }
  });
});
