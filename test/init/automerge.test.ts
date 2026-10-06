import { describe, expect, test } from "vitest";
import {
  actionsBranchPrefix,
  hasActionsExclusion,
  hasSiteExclusion,
  isAutoMergeWorkflow,
  patchAutoMerge,
  siteBranchPrefix,
} from "../../src/lib/automerge.js";
import { readFixture } from "./support/fixtures.js";
import { PILOTS } from "./support/shell.js";

const CONDITION = "if: ${{ github.actor == 'dependabot[bot]' }}";
const SITE = "!startsWith(github.head_ref, 'dependabot/npm_and_yarn/docs-site')";
const ACTIONS = "!startsWith(github.head_ref, 'dependabot/github_actions/')";
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

  test("the github-actions prefix is the one every github-actions branch starts with, grouped or not", () => {
    expect(actionsBranchPrefix).toBe("dependabot/github_actions/");
  });
});

describe("the standard condition", () => {
  test("gets both exclusions and a three-line comment, and nothing else changes", () => {
    const before = workflow(CONDITION);
    const { text, changed, note } = patchAutoMerge(before, "docs-site");
    expect(changed).toBe(true);
    expect(note).toBeUndefined();
    expect(text).toBe(
      workflow(
        [
          "# Updates of the documentation site's packages (docs-site/) and of the commit pin of its shared",
          "    # workflows (github-actions pull requests) are reviewed by a person: a merge to the default branch",
          "    # publishes the site.",
          `    if: \${{ github.actor == 'dependabot[bot]' && ${SITE} && ${ACTIONS} }}`,
        ].join("\n"),
      ),
    );
    expect(hasSiteExclusion(text, "docs-site")).toBe(true);
    expect(hasActionsExclusion(text)).toBe(true);
  });

  test("an exclusion of the dependency name elsewhere in the file counts: the site's is added alone, with the short comment", () => {
    const before = `${workflow(CONDITION)}      - if: \${{ !contains(steps.metadata.outputs.dependency-names, 'Avunu/docusystem') }}\n`;
    const { text, changed } = patchAutoMerge(before, "docs-site");
    expect(changed).toBe(true);
    expect(text).toContain(`    if: \${{ github.actor == 'dependabot[bot]' && ${SITE} }}\n`);
    expect(text).toContain("# The documentation site's package updates (docs-site/) are reviewed");
    expect(text).not.toContain(ACTIONS);
  });

  test("keeps the indentation of the line and tolerates spacing and a trailing comment", () => {
    const before = workflow("if: ${{github.actor=='dependabot[bot]'}}  # only bots", "      ");
    const { text, changed } = patchAutoMerge(before, "docs-site");
    expect(changed).toBe(true);
    expect(text).toContain("      # Updates of the documentation site's packages");
    expect(text).toContain("      # publishes the site.");
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
    // and the same line also keeps the pin of the shared workflows out of auto-merge
    expect(differing[0]?.[1]).toContain(ACTIONS);
    expect(hasActionsExclusion(text)).toBe(true);
    expect(patchAutoMerge(text, "docs-site").changed).toBe(false);
  });
});

describe("a workflow that excludes the site's branches but not the github-actions ones", () => {
  // the one that Dependabot's github-actions entry moves the pin of the shared workflows in: a merge publishes
  const excluding = (condition: string, indent = "    "): string => workflow(condition, indent);
  const before = excluding(`if: \${{ github.actor == 'dependabot[bot]' && ${SITE} }}`);

  test("gets the clause right after the site's, on the same line, and nothing else changes", () => {
    expect(hasActionsExclusion(before)).toBe(false);
    const { text, changed, note } = patchAutoMerge(before, "docs-site");
    expect(changed).toBe(true);
    expect(note).toBeUndefined();
    expect(text).toBe(
      excluding(`if: \${{ github.actor == 'dependabot[bot]' && ${SITE} && ${ACTIONS} }}`),
    );
    expect(patchAutoMerge(text, "docs-site")).toEqual({ text, changed: false });
  });

  test("the clause joins the same conjunction wherever the site's is, and CRLF and a folded block stay as they are", () => {
    const first = excluding(`if: \${{ ${SITE} && github.actor == 'dependabot[bot]' }}`);
    expect(patchAutoMerge(first, "docs-site").text).toContain(
      `\${{ ${SITE} && ${ACTIONS} && github.actor`,
    );
    const crlf = patchAutoMerge(before.replace(/\n/g, "\r\n"), "docs-site").text;
    expect(crlf.replace(/\r\n/g, "")).not.toContain("\n");
    expect(crlf).toContain(`${SITE} && ${ACTIONS} }}\r\n`);
    const folded = excluding(`if: >-\n      github.actor == 'dependabot[bot]' &&\n      ${SITE}`);
    expect(patchAutoMerge(folded, "docs-site").text).toContain(`      ${SITE} && ${ACTIONS}\n`);
  });

  test("a double-quoted site clause is found too", () => {
    const quoted = excluding(
      `if: \${{ github.actor == 'dependabot[bot]' && !startsWith(github.head_ref, "dependabot/npm_and_yarn/docs-site") }}`,
    );
    const { text } = patchAutoMerge(quoted, "docs-site");
    expect(text).toContain(`"dependabot/npm_and_yarn/docs-site") && ${ACTIONS} }}`);
  });

  test("a bun exclusion is converted and given the clause in the same line: a one-line change", () => {
    const bun = excluding(
      "if: ${{ github.actor == 'dependabot[bot]' && !startsWith(github.head_ref, 'dependabot/bun/docs-site') }}",
    );
    const { text, changed, note } = patchAutoMerge(bun, "docs-site");
    expect(changed).toBe(true);
    expect(note).toBeUndefined();
    expect(text).toBe(before.replace("}}", `&& ${ACTIONS} }}`));
  });

  test("a site exclusion of another shape is left alone, with the clause to add by hand", () => {
    const odd = excluding(
      "if: ${{ github.actor == 'dependabot[bot]' && !contains(github.head_ref, 'dependabot/npm_and_yarn/docs-site') }}",
    );
    const { text, changed, note } = patchAutoMerge(odd, "docs-site");
    expect(text).toBe(odd);
    expect(changed).toBe(false);
    expect(note).toContain(ACTIONS);
    expect(note).toContain("commit pin");
  });

  test("a site clause that only a comment shows, or that stands twice, is not guessed", () => {
    const commented = `${excluding("if: ${{ github.actor == 'dependabot[bot]' && !contains(github.head_ref, 'dependabot/npm_and_yarn/docs-site') }}")}# ${SITE}\n`;
    expect(patchAutoMerge(commented, "docs-site").changed).toBe(false);
    const twice = `${before}      - if: \${{ ${SITE} }}\n`;
    const { text, changed, note } = patchAutoMerge(twice, "docs-site");
    expect(text).toBe(twice);
    expect(changed).toBe(false);
    expect(note).toContain(ACTIONS);
  });

  test("the bun conversion is kept when the clause cannot be added: changed and a note", () => {
    const bun = excluding(
      "if: ${{ github.actor == 'dependabot[bot]' && !contains(github.head_ref, 'dependabot/bun/docs-site') }}",
    );
    const { text, changed, note } = patchAutoMerge(bun, "docs-site");
    expect(changed).toBe(true);
    expect(text).toContain("'dependabot/npm_and_yarn/docs-site'");
    expect(note).toContain(ACTIONS);
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
    expect(note).toContain(ACTIONS);
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

describe("hasActionsExclusion", () => {
  const line = (inside: string): string =>
    `if: \${{ github.actor == 'dependabot[bot]' && ${inside} }}`;

  test("needs the whole github_actions prefix and a negation", () => {
    expect(hasActionsExclusion(line(ACTIONS))).toBe(true);
    expect(
      hasActionsExclusion(line("!startsWith(github.head_ref, 'dependabot/github_actions')")),
    ).toBe(true);
    // a part of the prefix: a grouped pull request is on `dependabot/github_actions/<group>-<hash>`
    expect(
      hasActionsExclusion(
        line("!startsWith(github.head_ref, 'dependabot/github_actions/actions/')"),
      ),
    ).toBe(false);
    // the site's and the bun branches are not these
    expect(hasActionsExclusion(line(SITE))).toBe(false);
    // no negation: it would run only for them
    expect(
      hasActionsExclusion(line("startsWith(github.head_ref, 'dependabot/github_actions/')")),
    ).toBe(false);
  });

  test("a negated dependency-names test of Avunu/docusystem counts, a plain one does not", () => {
    expect(
      hasActionsExclusion(
        "if: ${{ !contains(steps.metadata.outputs.dependency-names, 'Avunu/docusystem') }}",
      ),
    ).toBe(true);
    expect(
      hasActionsExclusion(
        "if: ${{ contains(steps.metadata.outputs.dependency-names, 'Avunu/docusystem') }}",
      ),
    ).toBe(false);
    expect(
      hasActionsExclusion(
        "if: ${{ !contains(steps.metadata.outputs.dependency-names, 'actions/checkout') }}",
      ),
    ).toBe(false);
  });

  test("a comment that mentions the branch does not count", () => {
    expect(hasActionsExclusion(`# ${ACTIONS}\nif: true\n`)).toBe(false);
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
