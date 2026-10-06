import { describe, expect, test } from "vitest";
import { parse } from "yaml";
import {
  hasSiteExclusion,
  isAutoMergeWorkflow,
  patchAutoMerge,
  siteBranchPrefix,
} from "../../src/lib/automerge.js";
import { readFixture } from "./support/fixtures.js";
import { PILOTS } from "./support/shell.js";

const CONDITION = "if: ${{ github.actor == 'dependabot[bot]' }}";
const workflow = (condition: string): string =>
  [
    "name: Dependabot auto-merge",
    "on: pull_request",
    "jobs:",
    "  auto-merge:",
    "    runs-on: ubuntu-latest",
    `    ${condition}`,
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
    const before = [
      "jobs:",
      "  auto-merge:",
      "      runs-on: ubuntu-latest",
      "      if: ${{github.actor=='dependabot[bot]'}}  # only bots",
      "      steps:",
      '        - run: gh pr merge --auto --squash "$PR_URL"',
      "",
    ].join("\n");
    const { text, changed } = patchAutoMerge(before, "docs-site");
    expect(changed).toBe(true);
    expect(text).toContain("      # The documentation site's package updates");
    expect(text).toContain("      # default branch publishes the site.");
    expect(text).toContain(
      "      if: ${{ github.actor=='dependabot[bot]' && !startsWith(github.head_ref, 'dependabot/npm_and_yarn/docs-site') }}  # only bots",
    );
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

  test("excludes dependabot/bun/docs-site: it is rewritten to the npm branch, and the reason that no longer holds is corrected", () => {
    expect(hasSiteExclusion(real, "docs-site")).toBe(false); // the bun exclusion counts as missing
    const { text, changed } = patchAutoMerge(real, "docs-site");
    expect(changed).toBe(true);
    const before = real.split("\n");
    const after = text.split("\n");
    expect(after).toHaveLength(before.length);
    const differing = after.flatMap((line, i) => (line === before[i] ? [] : [[before[i], line]]));
    expect(differing).toHaveLength(2);
    expect(differing[0]?.[1]).toContain(
      "# check is path-filtered and cannot be a required check, so",
    );
    expect(differing[1]?.[1]).toContain(
      "!startsWith(github.head_ref, 'dependabot/npm_and_yarn/docs-site')",
    );
    expect(text).not.toContain("gated by a repository variable");
    expect(hasSiteExclusion(text, "docs-site")).toBe(true);
    expect(patchAutoMerge(text, "docs-site").changed).toBe(false);
  });
});

describe("the starter's reason for leaving the site out of auto-merge", () => {
  const bun =
    "if: ${{ github.actor == 'dependabot[bot]' && !startsWith(github.head_ref, 'dependabot/bun/docs-site') }}";
  const reason = (gap: string): string =>
    `# Reviewed by a person: the Docs${gap}workflow that builds the site is gated by a repository variable and is not a required check, so\n    # nothing else would stand in the way.\n    ${bun}`;

  test("is replaced on one line and across a line break", () => {
    for (const gap of [" ", "\n    # "]) {
      const { text } = patchAutoMerge(workflow(reason(gap)), "docs-site");
      expect(text, JSON.stringify(gap)).toContain(
        `the Docs${gap}check is path-filtered and cannot be a required check, so\n    # nothing else would stand in the way.`,
      );
      expect(text).not.toContain("gated by a repository variable");
    }
  });

  test("keeps CRLF line ends", () => {
    const { text } = patchAutoMerge(
      workflow(reason("\n    # ")).replace(/\n/g, "\r\n"),
      "docs-site",
    );
    expect(text.replace(/\r\n/g, "")).not.toContain("\n");
    expect(text).toContain("the Docs\r\n    # check is path-filtered");
  });

  test("only a workflow whose exclusion is converted gets it, and only that sentence changes", () => {
    const other = workflow(`# gated by a repository variable\n    ${bun}`);
    expect(patchAutoMerge(other, "docs-site").text).toBe(
      other.replace("dependabot/bun/docs-site", "dependabot/npm_and_yarn/docs-site"),
    );
    const done = workflow(reason(" ").replace("dependabot/bun/", "dependabot/npm_and_yarn/"));
    expect(patchAutoMerge(done, "docs-site")).toEqual({ text: done, changed: false });
  });
});

const PREFIX = "dependabot/npm_and_yarn/docs-site";
const CLAUSE = `!startsWith(github.head_ref, '${PREFIX}')`;

describe("the pull request's author as the condition (what zizmor recommends)", () => {
  const AUTHOR = "if: ${{ github.event.pull_request.user.login == 'dependabot[bot]' }}";

  test("gets the exclusion too, and the diff is the comment and the one line", () => {
    const before = workflow(AUTHOR);
    const { text, changed, note } = patchAutoMerge(before, "docs-site");
    expect(changed).toBe(true);
    expect(note).toBeUndefined();
    expect(text).toBe(
      workflow(
        [
          "# The documentation site's package updates (docs-site/) are reviewed by a person: a merge to the",
          "    # default branch publishes the site.",
          `    if: \${{ github.event.pull_request.user.login == 'dependabot[bot]' && ${CLAUSE} }}`,
        ].join("\n"),
      ),
    );
    expect(hasSiteExclusion(text, "docs-site")).toBe(true);
    expect(patchAutoMerge(text, "docs-site")).toEqual({ text, changed: false });
  });

  test("the operands in the other order are recognised", () => {
    const { text, changed } = patchAutoMerge(
      workflow("if: ${{ 'dependabot[bot]' == github.event.pull_request.user.login }}"),
      "docs-site",
    );
    expect(changed).toBe(true);
    expect(text).toContain(
      `'dependabot[bot]' == github.event.pull_request.user.login && ${CLAUSE} }}`,
    );
  });
});

describe("a condition with more in it", () => {
  test("keeps what is there and gains the clause at the end", () => {
    const { text, changed } = patchAutoMerge(
      workflow("if: ${{ github.actor == 'dependabot[bot]' && github.repository == 'Avunu/x' }}"),
      "docs-site",
    );
    expect(changed).toBe(true);
    expect(text).toContain(
      `    if: \${{ github.actor == 'dependabot[bot]' && github.repository == 'Avunu/x' && ${CLAUSE} }}`,
    );
  });

  test("an alternative is put in parentheses first, so that the clause binds to all of it", () => {
    const { text, changed } = patchAutoMerge(
      workflow(
        "if: ${{ github.actor == 'dependabot[bot]' || github.actor == 'dependabot-preview[bot]' }}",
      ),
      "docs-site",
    );
    expect(changed).toBe(true);
    expect(text).toContain(
      `if: \${{ (github.actor == 'dependabot[bot]' || github.actor == 'dependabot-preview[bot]') && ${CLAUSE} }}`,
    );
  });

  test("a bare expression (no ${{ }}) stays bare", () => {
    const { text, changed } = patchAutoMerge(
      workflow("if: github.event.pull_request.user.login == 'dependabot[bot]'"),
      "docs-site",
    );
    expect(changed).toBe(true);
    expect(text).toContain(
      `    if: github.event.pull_request.user.login == 'dependabot[bot]' && ${CLAUSE}\n`,
    );
  });

  test("a plain value over several lines gets the clause after its last line", () => {
    const { text, changed } = patchAutoMerge(
      workflow(
        "if: github.event.pull_request.user.login == 'dependabot[bot]' &&\n      github.repository == 'Avunu/x'",
      ),
      "docs-site",
    );
    expect(changed).toBe(true);
    expect(text).toContain(
      `    if: github.event.pull_request.user.login == 'dependabot[bot]' &&\n      github.repository == 'Avunu/x' && ${CLAUSE}\n`,
    );
  });
});

describe("a folded block (`if: >-`, the shape of the fleet's nixos-micro-desktop)", () => {
  const block = (header = ">-"): string =>
    workflow(
      [
        `if: ${header}`,
        "      github.event.pull_request.user.login == 'dependabot[bot]' &&",
        "      github.repository == 'Avunu/x'",
      ].join("\n"),
    );

  test.each([">-", ">", "|"])(
    "%s: the clause is a new first line and nothing else moves",
    (header) => {
      const before = block(header);
      const { text, changed, note } = patchAutoMerge(before, "docs-site");
      expect(changed).toBe(true);
      expect(note).toBeUndefined();
      expect(text).toBe(
        workflow(
          [
            "# The documentation site's package updates (docs-site/) are reviewed by a person: a merge to the",
            "    # default branch publishes the site.",
            `    if: ${header}`,
            `      ${CLAUSE} &&`,
            "      github.event.pull_request.user.login == 'dependabot[bot]' &&",
            "      github.repository == 'Avunu/x'",
          ].join("\n"),
        ),
      );
      expect(hasSiteExclusion(text, "docs-site")).toBe(true);
      expect(patchAutoMerge(text, "docs-site")).toEqual({ text, changed: false });
    },
  );

  test("what the block says to GitHub is the old condition with the clause in front", () => {
    const { text } = patchAutoMerge(block(), "docs-site");
    const job = parse(text).jobs["auto-merge"] as { if: string };
    expect(job.if).toBe(
      `${CLAUSE} && github.event.pull_request.user.login == 'dependabot[bot]' && github.repository == 'Avunu/x'`,
    );
  });

  test("CRLF files keep CRLF", () => {
    const { text } = patchAutoMerge(block().replace(/\n/g, "\r\n"), "docs-site");
    expect(text.replace(/\r\n/g, "")).not.toContain("\n");
    expect(text).toContain(`      ${CLAUSE} &&\r\n`);
  });

  test("a block with an alternative is left alone: the clause would bind to the first one only", () => {
    const before = workflow(
      [
        "if: >-",
        "      github.actor == 'dependabot[bot]' ||",
        "      github.actor == 'dependabot-preview[bot]'",
      ].join("\n"),
    );
    const { text, changed, note } = patchAutoMerge(before, "docs-site");
    expect(text).toBe(before);
    expect(changed).toBe(false);
    expect(note).toContain("line 6");
    expect(note).toContain(
      `if: \${{ (github.actor == 'dependabot[bot]' || github.actor == 'dependabot-preview[bot]') && ${CLAUSE} }}`,
    );
  });
});

describe("every other shape is left alone, with the line to paste", () => {
  test("a quoted condition: the note shows the condition and the finished line", () => {
    const before = workflow(`if: "github.actor == 'dependabot[bot]'"`);
    const { text, changed, note } = patchAutoMerge(before, "docs-site");
    expect(text).toBe(before);
    expect(changed).toBe(false);
    expect(note).toContain("the job `auto-merge`");
    expect(note).toContain("line 6: `github.actor == 'dependabot[bot]'`");
    expect(note).toContain(
      `replace its \`if:\` with \`if: \${{ github.actor == 'dependabot[bot]' && ${CLAUSE} }}\``,
    );
  });

  test("a condition that mixes text with an expression", () => {
    const before = workflow("if: x${{ github.actor == 'dependabot[bot]' }}");
    const { text, changed, note } = patchAutoMerge(before, "docs-site");
    expect(text).toBe(before);
    expect(changed).toBe(false);
    expect(note).toContain("mixes text and ${{ }} expressions");
    expect(note).toContain(CLAUSE);
  });

  test("the condition on the line after its key", () => {
    const before = workflow("if:\n      ${{ github.actor == 'dependabot[bot]' }}");
    const { text, changed, note } = patchAutoMerge(before, "docs-site");
    expect(text).toBe(before);
    expect(changed).toBe(false);
    expect(note).toContain(`if: \${{ github.actor == 'dependabot[bot]' && ${CLAUSE} }}`);
  });

  test("two jobs with a Dependabot condition: not guessed which one merges", () => {
    const two = [
      "name: x",
      "on: pull_request",
      "jobs:",
      "  label:",
      `    ${CONDITION}`,
      "    steps:",
      "      - run: echo labelled",
      "  auto-merge:",
      `    ${CONDITION}`,
      "    steps:",
      "      - run: gh pr merge --auto",
      "",
    ].join("\n");
    const { text, changed, note } = patchAutoMerge(two, "docs-site");
    expect(text).toBe(two);
    expect(changed).toBe(false);
    expect(note).toContain("`label`, `auto-merge`");
    expect(note).toContain(CLAUSE);
  });

  test("a step-level if is not a job's condition", () => {
    const before = [
      "name: x",
      "on: pull_request",
      "jobs:",
      "  auto-merge:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      `      - ${CONDITION}`,
      "        run: gh pr merge --auto",
      "",
    ].join("\n");
    const { text, changed, note } = patchAutoMerge(before, "docs-site");
    expect(text).toBe(before);
    expect(changed).toBe(false);
    expect(note).toContain("no job has a condition that tests for Dependabot");
    expect(note).toContain(CLAUSE);
  });

  test("no condition at all", () => {
    const before =
      "name: x\njobs:\n  a:\n    steps:\n      - run: gh pr merge --auto\n    # dependabot[bot]\n";
    const { changed, note } = patchAutoMerge(before, "docs-site");
    expect(changed).toBe(false);
    expect(note).toContain("no job has a condition that tests for Dependabot");
  });

  test("a workflow that is not valid YAML", () => {
    const before = `${workflow(CONDITION)}${workflow(CONDITION)}`; // every key twice
    const { text, changed, note } = patchAutoMerge(before, "docs-site");
    expect(text).toBe(before);
    expect(changed).toBe(false);
    expect(note).toContain("not valid YAML");
    expect(note).toContain(CLAUSE);
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
