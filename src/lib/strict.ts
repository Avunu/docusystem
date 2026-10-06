// Strictness: what makes a build fail and what only warns (sections 4.1 "Strictness" and 5.1 step 10 of
// the architecture decision record), and the readers of Jx's output that the classification rests on.
//
// Jx works around every document problem it understands, prints one line about it and carries on, and
// it ignores whatever it does not understand while still exiting 0. A build that published such a
// result would publish something the author did not intend, so a strict build (CI=true, --strict and
// every `check`) turns each of those lines into a failure. The lines are found by their wording, which
// is Jx's to change: test/integration runs the pinned Jx on a broken tree on every Jx bump, so a
// change of wording is caught there and not in a consumer's pull request.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { NavData } from "./types.js";

/**
 * The lines of Jx's output that are document problems, and not a hint about hosting: every
 * `Content ...` line (links, routes, ids, validation, callouts, relationships, missing assets), every
 * `Warning: ...` (an unserved route, a missing asset) and every error.
 */
export const PROBLEM: RegExp = /^(?:Content\b|Warning:|Error)/;

/** The lines of Jx's output that match PROBLEM, trimmed (Jx indents the second line of some of them). */
export function problemsIn(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => PROBLEM.test(line));
}

/** N of `Done: N routes → M files`, or null when Jx printed no such line. */
export function doneRoutes(output: string): number | null {
  const found = /^Done:\s+(\d+)\s+routes?/m.exec(output);
  return found === null ? null : Number(found[1]);
}

/**
 * `!lenient && (strict || CI=true)`, where lenient is `--lenient` or `DOCUSYSTEM_LENIENT=1`.
 * `check` is always strict and `dev` always lenient: they pass `strict: true` and `lenient: true`
 * (and `check` removes DOCUSYSTEM_LENIENT from the environment it passes, because it ignores it).
 */
export function isStrict(
  o: { lenient?: boolean; strict?: boolean },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const lenient = o.lenient === true || env.DOCUSYSTEM_LENIENT === "1";
  return !lenient && (o.strict === true || env.CI === "true");
}

/**
 * The files of `<root>/pages` that make exactly one route each: `.json` files whose path has no
 * `[param]` segment, leaving out what Jx leaves out (a name that starts with `_`, in a file or a
 * folder). A dynamic page makes as many routes as its `$paths` yields, which only Jx knows.
 */
function staticPages(pagesDir: string): number {
  let count = 0;
  const visit = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.name.startsWith("_") || entry.name.includes("[")) continue;
      if (entry.isDirectory()) visit(join(dir, entry.name));
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".json")) count++;
    }
  };
  visit(pagesDir);
  return count;
}

/**
 * The route count Jx has to report at least: one per documentation page the nav promises plus one per
 * static page of the root (normally two: `/` and the 404 page). Fewer means Jx dropped routes, which
 * it does without a word when two entries want one address or a template stops matching.
 */
export function expectedRoutes(nav: NavData, root: string): number {
  return Object.keys(nav.pages).length + staticPages(join(root, "pages"));
}

/** The final line of a failed strict build; `count` is how many problems were printed above it. */
export function strictFailure(count: number): string {
  return (
    `docusystem: ${count} document problem(s) above fail the build. ` +
    "Fix the documents, or run with --lenient while you work through them."
  );
}

/** The last line of a lenient build that had document problems: they are warnings now, errors in CI. */
export function lenientNotice(count: number): string {
  return (
    `docusystem: ${count} document problem(s) above are only warnings because the build is lenient. ` +
    "A strict build (CI=true, and every check) fails on them."
  );
}

/** The header of Jx's failure message when `content.docs.links` is `"error"` and a link is broken. */
const BROKEN_LINKS = /^Build failed: Content links: "[^"]*" has \d+ broken links?:/;

/**
 * The problems that only a failed Jx run lists. With `content.docs.links: "error"` (generated for
 * every strict build) Jx stops on broken links and prints them under `Build failed: Content links:`,
 * one `  - ...` line each, which PROBLEM does not match. They are returned as `Content links: ...`
 * lines so that they are counted and annotated like the others; they are not printed again, because
 * Jx's own output (echoed already) is where a reader finds them.
 */
export function failureProblems(output: string): string[] {
  const lines = output.split(/\r?\n/);
  const at = lines.findIndex((line) => BROKEN_LINKS.test(line));
  if (at < 0) return [];
  const found: string[] = [];
  for (const line of lines.slice(at + 1)) {
    const bullet = /^\s+- (.+)$/.exec(line);
    if (bullet === null) break;
    found.push(`Content links: ${bullet[1]}`);
  }
  return found;
}

/**
 * What a failed Jx run says about the native image library, as advice: `sharp` needs a C++ runtime
 * library that some systems (NixOS without a wrapper) do not put where Node looks, and the site does
 * not need it when images are not optimized.
 */
export function imageHint(output: string): string | null {
  if (!/sharp|libstdc\+\+/i.test(output)) return null;
  return (
    "hint: Jx could not load its native image library (sharp). If you cannot install it, add " +
    '"images": "off" to docusystem.config.json: the site is then built without image optimization.'
  );
}

/** A command line as a person would type it: a part with a space or a shell character is quoted. */
export function shellCommand(parts: string[]): string {
  return parts
    .map((part) =>
      /^[A-Za-z0-9_@%+=:,./-]+$/.test(part) ? part : `'${part.replaceAll("'", `'\\''`)}'`,
    )
    .join(" ");
}
