#!/usr/bin/env node
// A pull request is squash-merged, so its title (and any `BREAKING CHANGE:` note in its body) becomes
// the commit message release-please reads. Two things are checked:
//
//  1. the title is a Conventional Commit, or release-please cannot classify the change;
//  2. neither the title nor a BREAKING CHANGE note contains a raw HTML tag. release-please writes the
//     release pull request with its notes HTML-escaped, then re-parses them as HTML when it is merged;
//     a live `<tag>` swallows a closing element, the package is not found in the parsed release, and
//     the release is skipped with a green run (the same defect that dropped packages from Jx's own
//     releases; see commitlint.config.ts in jxsuite/jx).
//
//   PR_TITLE='feat: add search' PR_BODY='' node scripts/check-pr-title.mjs
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The Conventional Commit types: the ones release-please-config.json classifies (a test keeps them in step). */
export const TYPES = [
  "feat",
  "fix",
  "docs",
  "style",
  "refactor",
  "perf",
  "test",
  "build",
  "ci",
  "chore",
  "revert",
];
const SUBJECT = new RegExp(`^(?:${TYPES.join("|")})(?:\\([a-z0-9._/-]+\\))?!?: \\S.*$`);
const ANGLE_TAG = /<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?>|<!--/g;

/** Every angle-bracket tag in `text`, in order, without repeats. */
export function findAngleTags(text) {
  return [...new Set(text?.match(ANGLE_TAG) ?? [])];
}

/** The text of every `BREAKING CHANGE:` note in a body: from its line to the next blank line. */
export function breakingNotes(body) {
  const lines = (body ?? "").replaceAll("\r\n", "\n").split("\n");
  const notes = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^BREAKING[ -]CHANGE:/.test(lines[i])) continue;
    const note = [];
    for (let j = i; j < lines.length && lines[j].trim() !== ""; j += 1) note.push(lines[j]);
    notes.push(note.join("\n"));
    i += note.length;
  }
  return notes;
}

/** Problems with a pull request title and body, one sentence each. */
export function problemsWith(title, body) {
  const problems = [];
  if (!SUBJECT.test(title)) {
    problems.push(
      `the title "${title}" is not a Conventional Commit (type(scope)!: subject, type one of ${TYPES.join(", ")})`,
    );
  }
  const unsafe = [
    { part: "title", text: title },
    ...breakingNotes(body).map((text) => ({ part: "BREAKING CHANGE note", text })),
  ];
  for (const { part, text } of unsafe) {
    const tags = findAngleTags(text);
    if (tags.length > 0) {
      problems.push(
        `the ${part} contains ${tags.join(", ")}: say it in prose; backticks do not help (see CONTRIBUTING.md)`,
      );
    }
  }
  return problems;
}

// `import.meta.main` exists only on Node 24.2+; this must also run (and not silently pass) on 22.
if (
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const problems = problemsWith(process.env.PR_TITLE ?? "", process.env.PR_BODY ?? "");
  for (const problem of problems) console.error(`::error title=Pull request title::${problem}`);
  process.exit(problems.length > 0 ? 1 : 0);
}
