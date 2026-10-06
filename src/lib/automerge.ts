// The Dependabot auto-merge workflow of a repository and the docs site (section 2.2 of the
// architecture decision record). A merge to the default branch publishes the site, and the docs check
// is path-filtered and so cannot be a required status; therefore the pull requests that Dependabot
// opens for the site folder are reviewed by a person, and the auto-merge workflow must skip their
// branches. The ecosystem of the shell's lockfile is npm, so the branches are
// `dependabot/npm_and_yarn/<site folder>/...`.
//
// The same holds for the pull requests of Dependabot's github-actions entry: one of them moves the
// commit pin of the shared workflows, and the merge publishes the site with the new workflow code
// (the deploy job holds `pages: write` and `id-token: write`). Those branches are
// `dependabot/github_actions/...`; a grouped one carries the group's name and a hash, not the name of
// the dependency, so the prefix is the one thing that identifies them.

/** `dependabot/npm_and_yarn/docs-site`: what the branches of the site's Dependabot pull requests start with. */
export const siteBranchPrefix = (site: string): string => `dependabot/npm_and_yarn/${site}`;

/**
 * `dependabot/github_actions/`: what the branches of every github-actions pull request start with,
 * whichever directory or group they come from (`.../github-actions-18f7fbd978`, `.../actions/checkout-7`).
 */
export const actionsBranchPrefix = "dependabot/github_actions/";

const escapeRegExp = (text: string): string => text.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");

/** The workflow text without its comments (a `#` that starts a word runs to the end of the line). */
export const withoutComments = (text: string): string => text.replace(/(^|[ \t])#[^\r\n]*/gm, "$1");

/** Whether a workflow enables merging of Dependabot's pull requests (so that the site's must be left out of it). */
export function isAutoMergeWorkflow(text: string): boolean {
  const code = withoutComments(text);
  return /dependabot\[bot\]/.test(code) && /\bgh\s+pr\s+merge\b|auto-?merge/i.test(code);
}

/**
 * Whether the workflow already skips the site's branches: a line of code that mentions the exact
 * branch prefix and negates a test of it. A `dependabot/bun/...` exclusion does not count: the
 * site's pull requests come from `dependabot/npm_and_yarn/...`.
 */
export function hasSiteExclusion(text: string, site: string): boolean {
  const prefix = escapeRegExp(siteBranchPrefix(site));
  const mention = new RegExp(`${prefix}(?=['"/\\s)])`);
  return withoutComments(text)
    .split(/\r?\n/)
    .some((line) => mention.test(line) && line.includes("!"));
}

/**
 * Whether the workflow already skips the pull requests that move the pin of the shared workflows: a
 * line of code that negates a test of the whole `dependabot/github_actions/` prefix, or of the dependency
 * name `Avunu/docusystem` among `dependency-names` (the output of dependabot/fetch-metadata, which
 * lists every dependency of a grouped pull request). An exclusion of part of the prefix, such as
 * `dependabot/github_actions/actions/`, does not count: a grouped pull request is not on such a branch.
 */
export function hasActionsExclusion(text: string): boolean {
  const prefix = /dependabot\/github_actions\/?(?=['"])/;
  const named = /!\s*contains\([^\r\n]*dependency-names[^\r\n]*Avunu\/docusystem/i;
  return withoutComments(text)
    .split(/\r?\n/)
    .some((line) => (line.includes("!") && prefix.test(line)) || named.test(line));
}

const STANDARD =
  /^([ \t]*)if:[ \t]*\$\{\{[ \t]*github\.actor[ \t]*==[ \t]*'dependabot\[bot\]'[ \t]*\}\}[ \t]*(?:#[^\r\n]*)?(?=\r?$)/gm;

/**
 * `text` with `clause` joined by `&&` right after the site's own exclusion (the one clause that is
 * known to be a conjunct of the job's condition), or null when that exclusion is not exactly once in
 * the code of one line, so that a clause is never put where its meaning is a guess.
 */
function appendAfterSiteClause(text: string, site: string, clause: string): string | null {
  const siteClause = new RegExp(
    `!\\s*startsWith\\(\\s*github\\.head_ref\\s*,\\s*(['"])${escapeRegExp(siteBranchPrefix(site))}\\1\\s*\\)`,
  );
  const lines = text.split("\n");
  let hit: { line: number; end: number } | null = null;
  for (const [index, line] of lines.entries()) {
    const found = siteClause.exec(line);
    if (found === null) continue;
    const comment = line.search(/(^|[ \t])#/);
    if (comment !== -1 && comment < found.index) continue; // only a comment names it
    if (hit !== null) return null; // twice: not guessed which one is meant
    hit = { line: index, end: found.index + found[0].length };
  }
  if (hit === null) return null;
  const line = lines[hit.line] ?? "";
  lines[hit.line] = `${line.slice(0, hit.end)} && ${clause}${line.slice(hit.end)}`;
  return lines.join("\n");
}

/**
 * Keeps the site's pull requests, and the ones that move the commit pin of the shared workflows, out
 * of a Dependabot auto-merge workflow:
 *
 * - the standard condition `if: ${{ github.actor == 'dependabot[bot]' }}` (exactly once in the file)
 *   gets `&& !startsWith(github.head_ref, 'dependabot/npm_and_yarn/<site>') && !startsWith(github.head_ref,
 *   'dependabot/github_actions/')` and a two-line comment;
 * - an existing `dependabot/bun/<site>` exclusion (the copied starter has it) becomes
 *   `dependabot/npm_and_yarn/<site>`;
 * - a workflow that excludes the site's branches but not the github-actions ones gets
 *   `&& !startsWith(github.head_ref, 'dependabot/github_actions/')` right after the site's exclusion;
 * - a workflow that excludes both already is left alone;
 * - any other shape is left alone and `note` says which conditions to add by hand. A `note` can come
 *   with `changed`: the part that could be done was done (the bun exclusion converted).
 */
export function patchAutoMerge(
  text: string,
  site: string,
): { text: string; changed: boolean; note?: string } {
  const needSite = !hasSiteExclusion(text, site);
  const needActions = !hasActionsExclusion(text);
  if (!needSite && !needActions) return { text, changed: false };
  const wanted = siteBranchPrefix(site);
  const siteClause = `!startsWith(github.head_ref, '${wanted}')`;
  const actionsClause = `!startsWith(github.head_ref, '${actionsBranchPrefix}')`;

  let converted = text;
  let siteDone = !needSite;
  const bun = `dependabot/bun/${site}`;
  if (needSite && new RegExp(`${escapeRegExp(bun)}(?=['"/\\s)])`).test(withoutComments(text))) {
    converted = text.replaceAll(bun, wanted);
    siteDone = true;
  }

  if (siteDone) {
    if (!needActions) return { text: converted, changed: converted !== text };
    const appended = appendAfterSiteClause(converted, site, actionsClause);
    if (appended !== null) return { text: appended, changed: true };
    return {
      text: converted,
      changed: converted !== text,
      note:
        `its exclusion of the site's branches is not a plain \`${siteClause}\` that init can add to, and nothing keeps the pull requests of Dependabot's github-actions entry out of auto-merge: ` +
        `add \`${actionsClause}\` to the condition of the job that merges, so that a person reviews the move of the shared workflows' commit pin (a merge publishes the site with the new workflow code)`,
    };
  }

  const clauses = needActions ? [siteClause, actionsClause] : [siteClause];
  const matches = text.match(STANDARD) ?? [];
  if (matches.length === 1) {
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const condition = ["github.actor == 'dependabot[bot]'", ...clauses].join(" && ");
    const comment = needActions
      ? [
          `# Updates of the documentation site's packages (${site}/) and of the commit pin of its shared`,
          `# workflows (github-actions pull requests) are reviewed by a person: a merge to the default branch`,
          `# publishes the site.`,
        ]
      : [
          `# The documentation site's package updates (${site}/) are reviewed by a person: a merge to the`,
          `# default branch publishes the site.`,
        ];
    const next = text.replace(STANDARD, (_line, indent: string) =>
      [...comment.map((line) => `${indent}${line}`), `${indent}if: \${{ ${condition} }}`].join(eol),
    );
    return { text: next, changed: true };
  }

  return {
    text,
    changed: false,
    note:
      `its condition is not the standard \`if: \${{ github.actor == 'dependabot[bot]' }}\` (or appears ${matches.length === 0 ? "nowhere" : "more than once"}): ` +
      `add ${clauses.map((clause) => `\`${clause}\``).join(" and ")} to the condition of the job that merges, so that a person reviews the site's updates` +
      (needActions ? " and the move of the shared workflows' commit pin" : ""),
  };
}
