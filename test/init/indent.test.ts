// How `init` indents the JSON it writes (src/lib/indent.ts): the repository's formatter
// configuration first, then `.editorconfig`, then the root package.json, then two spaces.
import { describe, expect, test } from "vitest";
import { detectJsonIndent, indentOf } from "../../src/lib/indent.js";
import { tempDir, writeTree, type TreeSpec } from "../support/index.js";

const repo = (files: TreeSpec = {}): string => {
  const root = tempDir("docusystem-indent-");
  writeTree(root, files);
  return root;
};

describe("indentOf", () => {
  test("is the first indented line: a tab, or a count of spaces; null when there is none", () => {
    expect(indentOf('{\n\t"a": 1\n}\n')).toBe("\t");
    expect(indentOf('{\n    "a": 1\n}\n')).toBe(4);
    expect(indentOf('{\n  "a": {\n    "b": 1\n  }\n}\n')).toBe(2);
    expect(indentOf('{ "a": 1 }\n')).toBeNull();
    expect(indentOf("")).toBeNull();
  });
});

describe("detectJsonIndent", () => {
  test("is two spaces when the repository says nothing", () => {
    expect(detectJsonIndent(repo())).toBe(2);
    expect(detectJsonIndent(repo({ "package.json": '{ "name": "x" }\n' }))).toBe(2);
    expect(detectJsonIndent(repo({ "package.json": "{ not json" }))).toBe(2);
  });

  test("follows useTabs and tabWidth of the formatter configuration", () => {
    expect(detectJsonIndent(repo({ ".oxfmtrc.json": '{ "useTabs": true }' }))).toBe("\t");
    expect(detectJsonIndent(repo({ ".oxfmtrc.json": '{ "tabWidth": 4 }' }))).toBe(4);
    expect(detectJsonIndent(repo({ ".prettierrc": '{ "useTabs": true, "tabWidth": 4 }' }))).toBe(
      "\t",
    );
    expect(detectJsonIndent(repo({ ".prettierrc.json": '{ "useTabs": false }' }))).toBe(2);
  });

  test("reads a configuration with comments and trailing commas (.oxfmtrc.json allows both)", () => {
    const config = `{
	"$schema": "./node_modules/oxfmt/configuration_schema.json",
	// "useTabs": false, a comment that mentions the key
	"ignorePatterns": ["**/*.md", "a // b"], /* and a block comment */
	"jsdoc": true,
	"useTabs": true,
}
`;
    expect(detectJsonIndent(repo({ ".oxfmtrc.json": config }))).toBe("\t");
    expect(detectJsonIndent(repo({ ".oxfmtrc.jsonc": config }))).toBe("\t");
  });

  test("reads a YAML prettier configuration", () => {
    expect(detectJsonIndent(repo({ ".prettierrc.yaml": "useTabs: true\n" }))).toBe("\t");
    expect(detectJsonIndent(repo({ ".prettierrc.yml": "tabWidth: 3\n" }))).toBe(3);
    expect(detectJsonIndent(repo({ ".prettierrc": "tabWidth: 8\n" }))).toBe(8);
  });

  test("ignores a width that is not a count of spaces, and a configuration that cannot be read", () => {
    expect(detectJsonIndent(repo({ ".oxfmtrc.json": '{ "tabWidth": 0 }' }))).toBe(2);
    expect(detectJsonIndent(repo({ ".oxfmtrc.json": '{ "tabWidth": "four" }' }))).toBe(2);
    expect(
      detectJsonIndent(repo({ ".oxfmtrc.json": "{ nope", ".prettierrc": "useTabs: true\n" })),
    ).toBe("\t");
    expect(detectJsonIndent(repo({ ".oxfmtrc.json": "[]" }))).toBe(2);
  });

  test("reads .editorconfig: the section for every file or for JSON, later sections winning", () => {
    expect(
      detectJsonIndent(repo({ ".editorconfig": "root = true\n\n[*]\nindent_style = tab\n" })),
    ).toBe("\t");
    expect(
      detectJsonIndent(repo({ ".editorconfig": "[*]\nindent_style = space\nindent_size = 4\n" })),
    ).toBe(4);
    expect(
      detectJsonIndent(
        repo({ ".editorconfig": "[*]\nindent_style = space\n\n[*.json]\nindent_style = tab\n" }),
      ),
    ).toBe("\t");
    expect(
      detectJsonIndent(
        repo({
          ".editorconfig": "[*.{js,json}]\nindent_style = tab\n[*.py]\nindent_style = space\n",
        }),
      ),
    ).toBe("\t");
    expect(
      detectJsonIndent(repo({ ".editorconfig": "[{package.json,*.yml}]\nindent_size = 3\n" })),
    ).toBe(3);
    // `indent_size = tab` takes the width from tab_width
    expect(
      detectJsonIndent(
        repo({ ".editorconfig": "[*]\nindent_style = space\nindent_size = tab\ntab_width = 4\n" }),
      ),
    ).toBe(4);
  });

  test("an .editorconfig section that does not cover JSON is not the answer", () => {
    expect(
      detectJsonIndent(
        repo({ ".editorconfig": "[*.py]\nindent_style = tab\n[Makefile]\nindent_style = tab\n" }),
      ),
    ).toBe(2);
    expect(detectJsonIndent(repo({ ".editorconfig": "[src/**]\nindent_style = tab\n" }))).toBe(2);
  });

  test("the formatter configuration overrides .editorconfig key by key, as oxfmt does", () => {
    const editor = "[*]\nindent_style = tab\nindent_size = 4\n";
    expect(
      detectJsonIndent(repo({ ".editorconfig": editor, ".oxfmtrc.json": '{ "useTabs": false }' })),
    ).toBe(4);
    expect(
      detectJsonIndent(
        repo({
          ".editorconfig": "[*]\nindent_style = space\n",
          ".oxfmtrc.json": '{ "useTabs": true }',
        }),
      ),
    ).toBe("\t");
    expect(
      detectJsonIndent(repo({ ".editorconfig": editor, ".oxfmtrc.json": '{ "tabWidth": 8 }' })),
    ).toBe("\t");
  });

  test("falls back to the indentation of the root package.json when nothing is written down", () => {
    expect(detectJsonIndent(repo({ "package.json": '{\n\t"name": "x"\n}\n' }))).toBe("\t");
    expect(detectJsonIndent(repo({ "package.json": '{\n    "name": "x"\n}\n' }))).toBe(4);
    // a configuration that says something wins over the package.json
    expect(
      detectJsonIndent(
        repo({ "package.json": '{\n\t"name": "x"\n}\n', ".oxfmtrc.json": '{ "useTabs": false }' }),
      ),
    ).toBe(2);
  });

  test("a formatter configuration without indentation keys leaves the package.json fallback", () => {
    expect(
      detectJsonIndent(
        repo({ "package.json": '{\n\t"name": "x"\n}\n', ".oxfmtrc.json": '{ "printWidth": 110 }' }),
      ),
    ).toBe("\t");
  });
});
