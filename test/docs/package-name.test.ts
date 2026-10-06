// The package is `@avunu/docusystem`. The unscoped npm name `docusystem` is not ours: `npx docusystem`
// run in a folder where the package is not installed (the repository root is the usual one, because
// the package lives in docs-site/) asks the registry for that name, and runs whatever package owns
// it. Today the name is unregistered and the command fails with a 404; the day someone registers it,
// every reader who copied the command would run their code. So nothing this repository ships or
// documents may tell anyone to fetch or install the unscoped name. The scoped name always resolves to
// the package, from the installed copy where there is one.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";
import { REPO_ROOT } from "../support/index.js";

/**
 * A package runner or installer followed (after any flags) by the bare name `docusystem`, with or
 * without a version: `npx docusystem`, `npx -y docusystem@latest`, `bunx docusystem`,
 * `pnpm dlx docusystem`, `npm exec -- docusystem`, `npm install -g docusystem`. The scoped name does not
 * match, because the name must follow whitespace directly.
 */
const UNSCOPED =
  /\b(?:npx|bunx|pnpx|(?:pnpm|yarn) dlx|npm exec|(?:npm|pnpm|yarn|bun) (?:install|i|add))(?:[ \t]+--?[\w-]+(?:=\S+)?)*[ \t]+docusystem(?![\w-]|\.\w)/;

/** Where a text file can say how to run the CLI: the docs, the templates, the example and the CLI itself. */
const TEXT = /\.(?:md|ya?ml|json|mjs|ts)$/;
/** Folders that are not authored text here: dependencies, build output, and the tests themselves, which quote the pattern. */
const SKIPPED_DIRS = new Set([".docusystem", ".git", "dist", "node_modules", "test"]);
/** Generated from commit subjects, so it may quote history. */
const SKIPPED_FILES = new Set(["CHANGELOG.md", "package-lock.json"]);

function* textFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) yield* textFiles(path);
    } else if (entry.isFile() && TEXT.test(entry.name) && !SKIPPED_FILES.has(entry.name)) {
      yield path;
    }
  }
}

describe("the unscoped npm name docusystem", () => {
  test.each([
    "npx docusystem doctor",
    "npx docusystem@latest doctor",
    "npx -y docusystem doctor",
    "npx --yes docusystem upgrade",
    "bunx docusystem init",
    "pnpm dlx docusystem init",
    "yarn dlx docusystem init",
    "npm exec -- docusystem info",
    "npm exec docusystem",
    "npm install -g docusystem",
    "npm i docusystem",
    "pnpm add docusystem",
    "`npx docusystem --version`, run in your docs-site folder",
    "Run `npx docusystem upgrade`.",
    "npx docusystem.",
  ])("is recognized in %j", (text) => {
    expect(text).toMatch(UNSCOPED);
  });

  test.each([
    "npx @avunu/docusystem init --from-readme",
    "npx @avunu/docusystem doctor",
    "npx -y @avunu/docusystem doctor",
    "npm install @avunu/docusystem",
    "npm update @avunu/docusystem",
    "npm exec -- @avunu/docusystem info",
    "bun --bun ./node_modules/.bin/docusystem check",
    "./docs-site/node_modules/.bin/docusystem doctor",
    "npm run check",
    "docusystem doctor",
    "npx docusystem-foo",
    "npx docusystem.config.json",
    "the unscoped name `docusystem` is not this package",
  ])("is not mistaken for %j", (text) => {
    expect(text).not.toMatch(UNSCOPED);
  });

  test("no documentation, template, example or message tells anyone to run or install it", () => {
    const offenders: string[] = [];
    let scanned = 0;
    for (const file of textFiles(REPO_ROOT)) {
      scanned += 1;
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, index) => {
          if (UNSCOPED.test(line)) {
            offenders.push(`${relative(REPO_ROOT, file)}:${index + 1}: ${line.trim()}`);
          }
        });
    }
    // The walk itself must work: this repository has well over a hundred such files.
    expect(scanned).toBeGreaterThan(50);
    expect(
      offenders,
      "write `npx @avunu/docusystem <command>` (in docs-site/): the unscoped name `docusystem` is not this package",
    ).toEqual([]);
  });
});
