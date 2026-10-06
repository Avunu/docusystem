import { describe, expect, test } from "vitest";
import {
  hasSiteExclusion,
  isAutoMergeWorkflow,
  patchAutoMerge,
  siteBranchPrefix,
} from "../../src/lib/automerge.js";
import { readFixture } from "./support/fixtures.js";
import { PILOTS } from "./support/shell.js";

const CONDITION = "if: ${{ github.actor == 'dependabot[bot]' }}";
const workflow = (condition: string, indent = "    "): string =>
  [
    "name: Dependabot auto-merge",
    "on: pull_request",
    "jobs:",
    "  auto-merge:",
    "    runs-on: ubuntu-latest",
    `${indent}${condition}`,
    "    steps:",
    '      - run: gh pr merge --auto --squash "$PR_URL"',
    "",
  ].join("\n");

describe("siteBranchPrefix", () => {
  test("is the branch Dependabot uses for an npm lockfile", () => {
    expect(siteBranchPrefix("docs-site")).toBe("dependabot/npm_and_yarn/docs-site");
  });
});

describe("the standard condition", () => {
  test("gets the exclusion and a two-line comment, and nothing else changes", () => {
    const before = workflow(CONDITION);
    const { text, changed, note } = patchAutoMerge(before, "docs-site");
    expect(changed).toBe(true);
    expect(note).toBeUndefined();
    expect(text).toBe(
      workflow(
        [
          "# The documentation site's package updates (docs-site/) are reviewed by a person: a merge to the",
          "    # default branch publishes the site.",
          "    if: ${{ github.actor == 'dependabot[bot]' && !startsWith(github.head_ref, 'dependabot/npm_and_yarn/docs-site') }}",
        ].join("\n"),
      ),
    );
    expect(hasSiteExclusion(text, "docs-site")).toBe(true);
  });

  test("keeps the indentation of the line and tolerates spacing and a trailing comment", () => {
    const before = workflow("if: ${{github.actor=='dependabot[bot]'}}  # only bots", "      ");
    const { text, changed } = patchAutoMerge(before, "docs-site");
    expect(changed).toBe(true);
    expect(text).toContain("      # The documentation site's package updates");
    expect(text).toContain("      # default branch publishes the site.");
    expect(text).toContain("      if: ${{ github.actor == 'dependabot[bot]' && !startsWith(");
  });

  test("a nested site folder is named in the branch", () => {
    const { text } = patchAutoMerge(workflow(CONDITION), "tools/docs-site");
    expect(text).toContain("'dependabot/npm_and_yarn/tools/docs-site')");
    expect(text).toContain("(tools/docs-site/)");
  });

  test("CRLF files keep CRLF", () => {
    const { text } = patchAutoMerge(workflow(CONDITION).replace(/\n/g, "\r\n"), "docs-site");
    expect(text.replace(/\r\n/g, "")).not.toContain("\n");
    expect(hasSiteExclusion(text, "docs-site")).toBe(true);
  });

  test("patching twice changes nothing the second time", () => {
    const once = patchAutoMerge(workflow(CONDITION), "docs-site").text;
    expect(patchAutoMerge(once, "docs-site")).toEqual({ text: once, changed: false });
  });
});

describe.each(PILOTS)("the real auto-merge workflow of %s", (pilot) => {
  const real = readFixture("pilots", pilot, ".github", "workflows", "dependabot-auto-merge.yml");

  test("excludes dependabot/bun/docs-site: it is rewritten to the npm branch, a one-line diff", () => {
    expect(hasSiteExclusion(real, "docs-site")).toBe(false); // the bun exclusion counts as missing
    const { text, changed } = patchAutoMerge(real, "docs-site");
    expect(changed).toBe(true);
    const before = real.split("\n");
    const after = text.split("\n");
    expect(after).toHaveLength(before.length);
    const differing = after.flatMap((line, i) => (line === before[i] ? [] : [[before[i], line]]));
    expect(differing).toHaveLength(1);
    expect(differing[0]?.[1]).toContain(
      "!startsWith(github.head_ref, 'dependabot/npm_and_yarn/docs-site')",
    );
    expect(hasSiteExclusion(text, "docs-site")).toBe(true);
    expect(patchAutoMerge(text, "docs-site").changed).toBe(false);
  });
});

describe("every other shape is left alone", () => {
  test("a different condition: the note says what to add", () => {
    const before = workflow(
      "if: ${{ github.actor == 'dependabot[bot]' && github.event.pull_request.draft == false }}",
    );
    const { text, changed, note } = patchAutoMerge(before, "docs-site");
    expect(text).toBe(before);
    expect(changed).toBe(false);
    expect(note).toContain("!startsWith(github.head_ref, 'dependabot/npm_and_yarn/docs-site')");
  });

  test("the standard condition twice: not guessed which job is meant", () => {
    const twice = `${workflow(CONDITION)}${workflow(CONDITION)}`;
    const { text, changed, note } = patchAutoMerge(twice, "docs-site");
    expect(text).toBe(twice);
    expect(changed).toBe(false);
    expect(note).toContain("more than once");
  });

  test("a step-level if is not a job's condition", () => {
    const before = workflow(`- ${CONDITION}`);
    expect(patchAutoMerge(before, "docs-site").changed).toBe(false);
  });

  test("no condition at all", () => {
    const before =
      "name: x\njobs:\n  a:\n    steps:\n      - run: gh pr merge --auto\n    # dependabot[bot]\n";
    const { changed, note } = patchAutoMerge(before, "docs-site");
    expect(changed).toBe(false);
    expect(note).toContain("nowhere");
  });
});

describe("hasSiteExclusion", () => {
  const line = (inside: string): string =>
    `if: \${{ github.actor == 'dependabot[bot]' && ${inside} }}`;

  test("needs the exact branch prefix and a negation", () => {
    expect(
      hasSiteExclusion(
        line("!startsWith(github.head_ref, 'dependabot/npm_and_yarn/docs-site')"),
        "docs-site",
      ),
    ).toBe(true);
    expect(
      hasSiteExclusion(
        line("!startsWith(github.head_ref, 'dependabot/npm_and_yarn/docs-site/')"),
        "docs-site",
      ),
    ).toBe(true);
    // not the site
    expect(
      hasSiteExclusion(
        line("!startsWith(github.head_ref, 'dependabot/npm_and_yarn/docs-site-old')"),
        "docs-site",
      ),
    ).toBe(false);
    expect(
      hasSiteExclusion(
        line("!startsWith(github.head_ref, 'dependabot/npm_and_yarn/docs')"),
        "docs-site",
      ),
    ).toBe(false);
    // the bun branches are not the site's branches
    expect(
      hasSiteExclusion(
        line("!startsWith(github.head_ref, 'dependabot/bun/docs-site')"),
        "docs-site",
      ),
    ).toBe(false);
    // no negation: it would run only for the site
    expect(
      hasSiteExclusion(
        line("startsWith(github.head_ref, 'dependabot/npm_and_yarn/docs-site')"),
        "docs-site",
      ),
    ).toBe(false);
  });

  test("a comment that mentions the branch does not count", () => {
    expect(
      hasSiteExclusion("# skip dependabot/npm_and_yarn/docs-site !\nif: true\n", "docs-site"),
    ).toBe(false);
  });
});

describe("isAutoMergeWorkflow", () => {
  test("a workflow that merges Dependabot's pull requests", () => {
    expect(isAutoMergeWorkflow(workflow(CONDITION))).toBe(true);
    expect(
      isAutoMergeWorkflow(
        "if: github.actor == 'dependabot[bot]'\nsteps:\n  - uses: x/enable-pull-request-automerge@v1\n",
      ),
    ).toBe(true);
  });

  test("not one that only mentions Dependabot, or only merges", () => {
    expect(
      isAutoMergeWorkflow(
        "jobs:\n  a:\n    if: github.actor != 'dependabot[bot]'\n    steps:\n      - run: npm test\n",
      ),
    ).toBe(false);
    expect(isAutoMergeWorkflow("jobs:\n  a:\n    steps:\n      - run: gh pr merge --auto\n")).toBe(
      false,
    );
    expect(
      isAutoMergeWorkflow("# dependabot[bot] and gh pr merge are described here\njobs: {}\n"),
    ).toBe(false);
  });
});
