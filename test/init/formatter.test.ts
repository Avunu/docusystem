// What `init` writes must pass the adopting repository's own format check, or the pull request that
// adopts the system turns that repository's CI red. This runs the real oxfmt (the formatter of the
// fleet, a devDependency of this repository) over a repository after `init`, under the formatter
// configurations the fleet uses: the default one, tabs, a wide print width, a narrow one, and the
// settings that only an .editorconfig carries.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { runInit } from "../../src/commands/init.js";
import { renderScaffold } from "../../src/lib/workflows.js";
import { REPO_ROOT, tempDir, type TreeSpec } from "../support/index.js";
import { exec, makeRepo, readIn, SHA } from "./support/shell.js";

vi.mock("../../src/lib/config.js", (original) =>
  import("./support/neighbours.js").then((m) => m.mockConfig(original)),
);
vi.mock("../../src/lib/catalog.js", (original) =>
  import("./support/neighbours.js").then((m) => m.mockCatalog(original)),
);
vi.mock("../../src/lib/preflight.js", (original) =>
  import("./support/neighbours.js").then((m) => m.mockPreflight(original)),
);
vi.mock("../../src/lib/package-info.js", (original) =>
  import("./support/neighbours.js").then((m) => m.mockPackageInfo(original)),
);

const OXFMT = join(REPO_ROOT, "node_modules", "oxfmt", "bin", "oxfmt");

/** The colour codes that oxfmt prints when the terminal, or a CI runner, asks for colour. */
const COLOUR = new RegExp(String.raw`\u001b\[[0-9;]*m`, "g");
/** oxfmt with colour off, whatever the environment of the test run says. */
const OXFMT_ENV = { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" };

/** `oxfmt --check <files>` in `cwd`: the files it flags (none: the format check passes). */
function flagged(cwd: string, files: string[]): string[] {
  try {
    execFileSync(process.execPath, [OXFMT, "--check", ...files], {
      cwd,
      env: OXFMT_ENV,
      stdio: "pipe",
    });
    return [];
  } catch (error) {
    const out = String((error as { stdout?: Buffer }).stdout ?? "").replace(COLOUR, "");
    const lines = out.split("\n").filter((line) => /\(\d+ms\)/.test(line));
    if (lines.length === 0) throw error; // oxfmt itself failed, not the check
    return lines.map((line) => line.replace(/\s*\(\d+ms\)$/, "").trim());
  }
}

const JSON_FILES = ["docs-site/docusystem.config.json", "docs-site/package.json"];
const WORKFLOWS = [".github/workflows/docs.yml", ".github/workflows/docs-publish.yml"];
const SHELL = [...JSON_FILES, ...WORKFLOWS, ".github/dependabot.yml"];

/** A repository with `files`, initialised; returns its root. */
async function adopt(files: TreeSpec, options: Parameters<typeof exec>[1]["options"] = {}) {
  const root = makeRepo({ files: { "docs/README.md": "# Home\n", ...files } });
  const { code, err } = await exec(
    (ctx) => runInit(ctx, { resolvePin: () => ({ sha: SHA, reason: null }) }),
    { command: "init", cwd: root, options },
  );
  expect(err).toBe("");
  expect(code).toBe(0);
  return root;
}

const json = (value: unknown): string => `${JSON.stringify(value)}\n`;

describe("what init writes passes the repository's own oxfmt check", () => {
  test("the check can fail on a shell: the one-line paths list that init used to write is re-wrapped", () => {
    // Why the rest of this file is worth running: this is the shape that turned adoption pull
    // requests red, and a block list is the shape that does not.
    const root = tempDir("docusystem-oxfmt-");
    const oneLine = renderScaffold("docs.yml", {
      docs: "docs",
      site: "docs-site",
      sha: SHA,
      version: "0.1.0",
    }).replace(
      /paths:\n(?: {6}- .*\n){4}/,
      'paths: ["docs/**", "docs-site/**", ".github/workflows/docs.yml", ".github/workflows/docs-publish.yml"]\n',
    );
    expect(oneLine).toContain('paths: ["docs/**"');
    writeFileSync(join(root, "docs.yml"), oneLine);
    expect(flagged(root, ["docs.yml"])).toEqual(["docs.yml"]);
  });

  test("a repository with no formatter configuration (oxfmt's defaults)", async () => {
    const root = await adopt({});
    expect(flagged(root, ["docs-site", ".github"])).toEqual([]);
  });

  test("a repository that formats with tabs, as the fleet's .oxfmtrc.json does", async () => {
    const root = await adopt({
      ".oxfmtrc.json": `{
\t"$schema": "./node_modules/oxfmt/configuration_schema.json",
\t// Markdown is excluded wholesale
\t"ignorePatterns": ["**/*.md", "CHANGELOG.md", "dist", "node_modules", "package-lock.json"],
\t"jsdoc": true,
\t"useTabs": true
}
`,
    });
    expect(readIn(root, "docs-site/package.json")).toContain('{\n\t"name": ');
    expect(readIn(root, "docs-site/docusystem.config.json")).toContain('{\n\t"$schema": ');
    expect(flagged(root, SHELL)).toEqual([]);
  });

  test("a repository that formats with tabs at print width 110 (carbon_frappe's shape)", async () => {
    const root = await adopt({ ".oxfmtrc.json": json({ useTabs: true, printWidth: 110 }) });
    expect(flagged(root, SHELL)).toEqual([]);
  });

  test("a repository that formats JSON with four spaces", async () => {
    // oxfmt also indents YAML by tabWidth, which init does not follow: only the JSON is held to it
    const root = await adopt({ ".oxfmtrc.json": json({ tabWidth: 4 }) });
    expect(readIn(root, "docs-site/package.json")).toContain('{\n    "name": ');
    expect(flagged(root, JSON_FILES)).toEqual([]);
  });

  test("a repository whose tabs are only in its .editorconfig", async () => {
    const root = await adopt({ ".editorconfig": "root = true\n\n[*]\nindent_style = tab\n" });
    expect(readIn(root, "docs-site/package.json")).toContain('{\n\t"name": ');
    expect(flagged(root, SHELL)).toEqual([]);
  });

  test("a repository whose only sign is the tabs of its own package.json", async () => {
    const root = await adopt({ "package.json": '{\n\t"name": "x",\n\t"private": true\n}\n' });
    expect(readIn(root, "docs-site/package.json")).toContain('{\n\t"name": ');
    // no formatter configuration: oxfmt's defaults would flag the tabs of the root package.json
    // itself, so only the files init wrote are checked here, under the configuration that its tabs imply
    writeFileSync(join(root, ".oxfmtrc.json"), json({ useTabs: true }));
    expect(flagged(root, SHELL)).toEqual([]);
  });

  test.each([30, 60, 80, 100, 140, 320])(
    "the workflows are stable at print width %i, and with single quotes",
    async (printWidth) => {
      const wide = await adopt({ ".oxfmtrc.json": json({ printWidth, useTabs: true }) });
      expect(flagged(wide, SHELL)).toEqual([]);
      // the paths are plain scalars, so no quote style rewrites them (dependabot.yml quotes `*` and
      // `@avunu/docusystem`, which no plain scalar can do, so it is left out of this one)
      const single = await adopt({ ".oxfmtrc.json": json({ printWidth, singleQuote: true }) });
      expect(flagged(single, [...JSON_FILES, ...WORKFLOWS])).toEqual([]);
    },
  );

  test("a long docs folder and a nested site folder do not make the workflows wrap", async () => {
    const root = await adopt(
      {
        "documentation/for/maintainers/README.md": "# Home\n",
        ".oxfmtrc.json": json({ printWidth: 40 }),
      },
      { siteDir: "tools/docs/site", docs: "../../../documentation/for/maintainers" },
    );
    expect(readIn(root, ".github/workflows/docs.yml")).toContain(
      "      - documentation/for/maintainers/**\n      - tools/docs/site/**\n",
    );
    expect(
      flagged(root, [
        "tools/docs/site/docusystem.config.json",
        "tools/docs/site/package.json",
        ".github/workflows/docs.yml",
        ".github/workflows/docs-publish.yml",
      ]),
    ).toEqual([]);
  });

  test("a docs folder that is the repository root (the one quoted entry) is stable at the defaults", async () => {
    const root = await adopt({ "README.md": "# Home\n" }, { docs: ".." });
    expect(readIn(root, ".github/workflows/docs.yml")).toContain(
      '      - "**"\n      - docs-site/**\n',
    );
    expect(
      flagged(root, [".github/workflows/docs.yml", ".github/workflows/docs-publish.yml"]),
    ).toEqual([]);
  });

  test("running init again after the formatter has run changes nothing", async () => {
    const root = await adopt({ ".oxfmtrc.json": json({ useTabs: true }) });
    execFileSync(process.execPath, [OXFMT, "docs-site", ".github"], {
      cwd: root,
      env: OXFMT_ENV,
      stdio: "pipe",
    });
    const { code, out, err } = await exec(
      (ctx) => runInit(ctx, { resolvePin: () => ({ sha: SHA, reason: null }) }),
      { command: "init", cwd: root },
    );
    expect(err).toBe("");
    expect(code).toBe(0);
    expect(out).toContain("init: nothing to do: the shell is in place");
  });
});
