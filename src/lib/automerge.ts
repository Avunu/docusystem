// The Dependabot auto-merge workflow of a repository and the docs site (section 2.2 of the
// architecture decision record). A merge to the default branch publishes the site, and the docs check
// is path-filtered and so cannot be a required status; therefore the pull requests that Dependabot
// opens for the site folder are reviewed by a person, and the auto-merge workflow must skip their
// branches. The ecosystem of the shell's lockfile is npm, so the branches are
// `dependabot/npm_and_yarn/<site folder>/...`.
import { isMap, isScalar, parseDocument, Scalar } from "yaml";

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

/** `github.actor` and the pull request's author are the two ways a workflow tells that Dependabot is the one it is dealing with. */
const WHO = String.raw`(?:github\.actor|github\.event\.pull_request\.user\.login)`;
const DEPENDABOT = String.raw`'dependabot\[bot\]'`;
const DEPENDABOT_TEST = new RegExp(`${WHO}\\s*==\\s*${DEPENDABOT}|${DEPENDABOT}\\s*==\\s*${WHO}`);

/** The job-level `if:` of a job, as the `yaml` parser found it. */
interface JobCondition {
  job: string;
  /** The scalar of the condition, with its `range` in the text. */
  node: Scalar;
  /** The condition as an expression: without a `${{ }}` wrapper, on one line; null when it mixes both. */
  expression: string | null;
}

/** The expression of an `if:` value, whether or not it is wrapped in `${{ }}`; null for a value that mixes text and expressions. */
function expressionOf(value: string): string | null {
  const trimmed = value.trim();
  const inner = /^\$\{\{([\s\S]*)\}\}$/.exec(trimmed)?.[1] ?? trimmed;
  if (inner.includes("${{") || inner.includes("}}")) return null;
  return inner.replace(/\s+/g, " ").trim();
}

/** `<expression> && <clause>`; an expression with an `||` in it is put in parentheses first, so that the clause binds to all of it. */
const andClause = (expression: string, clause: string): string =>
  `${expression.includes("||") ? `(${expression})` : expression} && ${clause}`;

/**
 * The job-level conditions of the workflow that test for Dependabot as the author or the actor (a
 * step-level `if:` is not a job's condition), or the reason the text is not a workflow `yaml` can read.
 */
function dependabotConditions(text: string): { conditions: JobCondition[] } | { error: string } {
  const doc = parseDocument(text);
  const first = doc.errors[0];
  if (first !== undefined) return { error: first.message.split("\n")[0] ?? "invalid" };
  const jobs = doc.get("jobs", true);
  const conditions: JobCondition[] = [];
  if (!isMap(jobs)) return { conditions };
  for (const pair of jobs.items) {
    const job = pair.value;
    if (!isMap(job)) continue;
    const node = job.get("if", true);
    if (!isScalar(node) || typeof node.value !== "string" || !DEPENDABOT_TEST.test(node.value))
      continue;
    conditions.push({
      job: String(isScalar(pair.key) ? pair.key.value : pair.key),
      node,
      expression: expressionOf(node.value),
    });
  }
  return { conditions };
}

/** The 1-based line of an offset in the text. */
const lineOf = (text: string, offset: number): number => text.slice(0, offset).split("\n").length;

/**
 * The text with `clause` joined to the job's condition and a two-line comment above it, or null when
 * the condition has a shape that is not rewritten safely:
 *
 * - a plain value, one line or several, `${{ ... }}` or a bare expression: the clause is appended;
 * - a `>-`, `>` or `|` block: the clause is a new first line, so the lines that were there stay as they are
 *   (not when the block has an `||`, which would bind the clause to the first alternative only, or a `${{`).
 */
function patchCondition(
  text: string,
  { node }: JobCondition,
  clause: string,
  site: string,
): string | null {
  if (node.range == null || typeof node.value !== "string") return null;
  const [start, end] = node.range;
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const key = /^([ \t]*)if:[ \t]+$/.exec(text.slice(lineStart, start));
  if (key === null) return null; // the value is not on the line of its key
  const indent = key[1] ?? "";
  const eol = text.includes("\r\n") ? "\r\n" : "\n";

  let at: number;
  let remove = 0;
  let insert: string;
  if (node.type === Scalar.PLAIN) {
    const raw = text.slice(start, end);
    const wrapped = /^\$\{\{([\s\S]*)\}\}$/.exec(raw);
    const inner = wrapped?.[1] ?? raw;
    if (inner.includes("${{") || inner.includes("}}")) return null;
    at = start;
    remove = end - start;
    insert = wrapped ? `\${{ ${andClause(inner.trim(), clause)} }}` : andClause(raw.trim(), clause);
  } else if (node.type === Scalar.BLOCK_FOLDED || node.type === Scalar.BLOCK_LITERAL) {
    if (node.value.includes("||") || node.value.includes("${{")) return null;
    const header = text.indexOf("\n", start);
    if (header < 0 || header >= end) return null;
    at = header + 1;
    let line = "";
    while (at < end) {
      const next = text.indexOf("\n", at);
      line = text.slice(at, next < 0 ? text.length : next);
      if (line.trim() !== "") break;
      if (next < 0) return null;
      at = next + 1;
    }
    if (line.trim() === "") return null;
    insert = `${/^[ \t]*/.exec(line)?.[0] ?? ""}${clause} &&${eol}`;
  } else {
    return null;
  }

  const comment = [
    `${indent}# The documentation site's package updates (${site}/) are reviewed by a person: a merge to the`,
    `${indent}# default branch publishes the site.`,
    "",
  ].join(eol);
  // the comment goes above the `if:` line, the clause where the condition is
  return (
    text.slice(0, lineStart) +
    comment +
    text.slice(lineStart, at) +
    insert +
    text.slice(at + remove)
  );
}

/**
 * Keeps the site's pull requests out of a Dependabot auto-merge workflow:
 *
 * - the job whose `if:` tests that Dependabot is the actor (`github.actor == 'dependabot[bot]'`) or the
 *   author (`github.event.pull_request.user.login == 'dependabot[bot]'`, the form that zizmor recommends),
 *   as `${{ ... }}`, a bare expression, or a folded block, gets `&& !startsWith(github.head_ref,
 *   'dependabot/npm_and_yarn/<site>')` and a two-line comment;
 * - an existing `dependabot/bun/<site>` exclusion (the copied starter has it) becomes
 *   `dependabot/npm_and_yarn/<site>`;
 * - a workflow that excludes the site already is left alone;
 * - any other shape (no such job, several, a quoted or mixed condition, invalid YAML) is left alone and
 *   `note` says what to do by hand, with the finished line to paste when there is one condition to build it from.
 */
export function patchAutoMerge(
  text: string,
  site: string,
): { text: string; changed: boolean; note?: string } {
  if (hasSiteExclusion(text, site)) return { text, changed: false };
  const wanted = siteBranchPrefix(site);

  const bun = `dependabot/bun/${site}`;
  if (new RegExp(`${escapeRegExp(bun)}(?=['"/\\s)])`).test(withoutComments(text))) {
    const next = text.replaceAll(bun, wanted);
    return { text: next, changed: next !== text };
  }

  const clause = `!startsWith(github.head_ref, '${wanted}')`;
  const toDo = `add \`${clause}\` to the condition of the job that merges, joined to it with \`&&\`, so that a person reviews the site's updates`;
  const left = (note: string): { text: string; changed: false; note: string } => ({
    text,
    changed: false,
    note,
  });

  const found = dependabotConditions(text);
  if ("error" in found) return left(`it is not valid YAML (${found.error}): ${toDo}`);
  const [only, ...more] = found.conditions;
  if (only === undefined) {
    return left(
      `no job has a condition that tests for Dependabot as the author or the actor: ${toDo}`,
    );
  }
  if (more.length > 0) {
    const jobs = found.conditions.map(({ job }) => `\`${job}\``).join(", ");
    return left(
      `the jobs ${jobs} all have a condition that tests for Dependabot, and init does not guess which one merges: ${toDo}`,
    );
  }

  const patched = patchCondition(text, only, clause, site);
  if (patched !== null) return { text: patched, changed: true };
  const where = `the condition of the job \`${only.job}\` (line ${lineOf(text, only.node.range?.[0] ?? 0)}`;
  if (only.expression === null) {
    return left(
      `${where}) mixes text and \${{ }} expressions, which init does not rewrite: ${toDo}`,
    );
  }
  return left(
    `${where}: \`${only.expression}\`) is a shape init does not rewrite: replace its \`if:\` with \`if: \${{ ${andClause(only.expression, clause)} }}\``,
  );
}
