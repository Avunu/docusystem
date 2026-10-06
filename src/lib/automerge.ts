// The Dependabot auto-merge workflow of a repository and the docs site (section 2.2 of the
// architecture decision record). A merge to the default branch publishes the site, and the docs check
// is path-filtered and so cannot be a required status; therefore the pull requests that Dependabot
// opens for the site folder are reviewed by a person, and the auto-merge workflow must skip their
// branches. The ecosystem of the shell's lockfile is npm, so the branches are
// `dependabot/npm_and_yarn/<site folder>/...`.

/** `dependabot/npm_and_yarn/docs-site`: what the branches of the site's Dependabot pull requests start with. */
export const siteBranchPrefix = (site: string): string => `dependabot/npm_and_yarn/${site}`;

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
 * The reason the first adopters gave for leaving the site out of auto-merge: their own starter's workflow
 * was gated by a repository variable. The shared `docs.yml` is not (only the deploy waits for the
 * variable); what keeps it from being a required check is its path filter.
 */
const STARTER_REASON =
  /the Docs([ \t]+|[ \t]*\r?\n[ \t]*#[ \t]*)workflow that builds the site is gated by a repository variable and is not a required check/;

const STANDARD =
  /^([ \t]*)if:[ \t]*\$\{\{[ \t]*github\.actor[ \t]*==[ \t]*'dependabot\[bot\]'[ \t]*\}\}[ \t]*(?:#[^\r\n]*)?(?=\r?$)/gm;

/**
 * Keeps the site's pull requests out of a Dependabot auto-merge workflow:
 *
 * - the standard condition `if: ${{ github.actor == 'dependabot[bot]' }}` (exactly once in the file)
 *   gets `&& !startsWith(github.head_ref, 'dependabot/npm_and_yarn/<site>')` and a two-line comment;
 * - an existing `dependabot/bun/<site>` exclusion (the copied starter has it) becomes
 *   `dependabot/npm_and_yarn/<site>`, and the comment that gives the starter's reason (a workflow gated
 *   by a repository variable) gives the shared workflow's instead (its check is path-filtered);
 * - a workflow that excludes the site already is left alone;
 * - any other shape is left alone and `note` says which condition to add by hand.
 */
export function patchAutoMerge(
  text: string,
  site: string,
): { text: string; changed: boolean; note?: string } {
  if (hasSiteExclusion(text, site)) return { text, changed: false };
  const wanted = siteBranchPrefix(site);

  const bun = `dependabot/bun/${site}`;
  if (new RegExp(`${escapeRegExp(bun)}(?=['"/\\s)])`).test(withoutComments(text))) {
    const next = text
      .replaceAll(bun, wanted)
      .replace(
        STARTER_REASON,
        (_reason, gap: string) =>
          `the Docs${gap}check is path-filtered and cannot be a required check`,
      );
    return { text: next, changed: next !== text };
  }

  const matches = text.match(STANDARD) ?? [];
  if (matches.length === 1) {
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const next = text.replace(STANDARD, (_line, indent: string) =>
      [
        `${indent}# The documentation site's package updates (${site}/) are reviewed by a person: a merge to the`,
        `${indent}# default branch publishes the site.`,
        `${indent}if: \${{ github.actor == 'dependabot[bot]' && !startsWith(github.head_ref, '${wanted}') }}`,
      ].join(eol),
    );
    return { text: next, changed: true };
  }

  return {
    text,
    changed: false,
    note:
      `its condition is not the standard \`if: \${{ github.actor == 'dependabot[bot]' }}\` (or appears ${matches.length === 0 ? "nowhere" : "more than once"}): ` +
      `add \`!startsWith(github.head_ref, '${wanted}')\` to the condition of the job that merges, so that a person reviews the site's updates`,
  };
}
