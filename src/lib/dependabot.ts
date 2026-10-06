// `.github/dependabot.yml` for a docs shell (sections 2.2 and 4.1.3 of the architecture decision
// record). `init` and `upgrade` ADD entries to the file a repository already has and never replace it;
// `doctor` reads the entries and judges them. Both read the file as YAML, entry by entry, so that
// `npm /` followed by `bun /docs-site` is not mistaken for an npm entry of the docs site (the
// "false OK" of the judges' reviews).
//
// How an entry is added, in order of preference, so that the repository's own text (its comments, its
// quoting, its order) stays byte for byte what it was:
//   1. a block list of entries: the snippet is inserted straight after the last entry, indented like
//      the entries already there (this is the end of the file when `updates:` is the last key);
//   2. no `updates:` key: the key and the snippets are appended;
//   3. `updates: []`, or a flow list: the yaml Document API replaces the list, comments kept;
//   4. anything else (not YAML, `updates` is not a list, an entry that is not a mapping): refused with
//      a DependabotShapeError that carries the snippet, to be added by hand.
//
// A bun entry that becomes npm is the entry that tracks `@avunu/docusystem`, so it also gets that package
// under its `cooldown.exclude` (a cooldown that held the package back would contradict the guide) and the
// comments above it that name Bun are brought up to date. The entries `init` does not rewrite (an npm entry
// that was there already, the github-actions entry) are only judged: `cooldownAdvice` says what to add.
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  isMap,
  isScalar,
  isSeq,
  parseDocument,
  type Document,
  type YAMLMap,
  type YAMLSeq,
} from "yaml";
import { name as PACKAGE, REPOSITORY } from "./package-info.js";
import { fillTemplate, readScaffold, siteDirProblem } from "./workflows.js";

/**
 * The existing file cannot be edited safely: `message` completes the sentence "<the file> <message>"
 * ("is not valid YAML (...)", "has an `updates` that is not a list") and `snippet` is what to add by hand.
 */
export class DependabotShapeError extends Error {
  snippet: string;

  constructor(message: string, snippet: string) {
    super(message);
    this.name = "DependabotShapeError";
    this.snippet = snippet;
  }
}

/** Dependabot reads `dependabot.yml` and `dependabot.yaml`: the one the repository has (the first if both), else `.yml`; relative to the repository root. */
export function dependabotFile(repoRoot: string): string {
  for (const name of ["dependabot.yml", "dependabot.yaml"]) {
    if (existsSync(join(repoRoot, ".github", name))) return `.github/${name}`;
  }
  return ".github/dependabot.yml";
}

/** The snippet for the docs site's npm entry, as a list item indented by two spaces. */
export function npmSnippet(site: string): string {
  return fillTemplate(readScaffold("dependabot-npm.yml"), { SITE: site });
}

/** The snippet for the github-actions entry (the pins in `.github/workflows`), indented by two spaces. */
export function actionsSnippet(): string {
  return readScaffold("dependabot-actions.yml");
}

/** One entry of `updates:`, as `doctor` and `ensureDependabotEntries` see it. */
export interface DependabotEntry {
  ecosystem: string;
  /** `directory` and `directories`, each with a leading `/` and no trailing one (except the root). */
  directories: string[];
  cooldown: {
    /** The entry has a `cooldown:` of any kind. */
    present: boolean;
    /** The package names it excludes from the cooldown. */
    excludes: string[];
  };
}

const normalizeDirectory = (value: string): string => {
  const slashed = value.startsWith("/") ? value : `/${value}`;
  return slashed.length > 1 ? slashed.replace(/\/+$/, "") || "/" : slashed;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The entry of a parsed mapping, or null when it is not one a Dependabot file can have. */
function entryOf(value: unknown): DependabotEntry | null {
  if (!isRecord(value)) return null;
  const ecosystem = value["package-ecosystem"];
  if (typeof ecosystem !== "string") return null;
  const directories: string[] = [];
  if (typeof value.directory === "string") directories.push(normalizeDirectory(value.directory));
  if (Array.isArray(value.directories)) {
    for (const directory of value.directories) {
      if (typeof directory === "string") directories.push(normalizeDirectory(directory));
    }
  }
  const cooldown = value.cooldown;
  const excludes =
    isRecord(cooldown) && Array.isArray(cooldown.exclude)
      ? cooldown.exclude.filter((name): name is string => typeof name === "string")
      : [];
  return { ecosystem, directories, cooldown: { present: isRecord(cooldown), excludes } };
}

/**
 * The entries of a dependabot.yml, in order; `error` when the text is not a Dependabot file that can
 * be read (invalid YAML, `updates` is not a list). A file without `updates` has no entries.
 */
export function readDependabotEntries(text: string): {
  entries: DependabotEntry[];
  error?: string;
} {
  const doc = parseDocument(text);
  const failure = doc.errors[0];
  if (failure !== undefined) return { entries: [], error: failure.message.split("\n")[0] ?? "" };
  const js: unknown = doc.toJS();
  if (js === null || js === undefined) return { entries: [] };
  if (!isRecord(js)) return { entries: [], error: "the top level is not a mapping" };
  if (js.updates === undefined || js.updates === null) return { entries: [] };
  if (!Array.isArray(js.updates)) return { entries: [], error: "`updates` is not a list" };
  const entries: DependabotEntry[] = [];
  for (const item of js.updates) {
    const entry = entryOf(item);
    if (entry === null)
      return {
        entries: [],
        error: "an entry of `updates` is not a mapping with a package-ecosystem",
      };
    entries.push(entry);
  }
  return { entries };
}

const hasNewline = (text: string): boolean => text.endsWith("\n");
const eolOf = (text: string): string => (text.includes("\r\n") ? "\r\n" : "\n");

/** `snippet` (indented by two spaces) shifted so that its list items sit at column `indent`. */
function reindent(snippet: string, indent: number): string {
  const shift = indent - 2;
  if (shift === 0) return snippet;
  return snippet
    .split("\n")
    .map((line) => {
      if (line === "") return line;
      return shift > 0 ? `${" ".repeat(shift)}${line}` : line.slice(Math.min(-shift, line.length));
    })
    .join("\n");
}

const entriesOfSeq = (seq: YAMLSeq, doc: Document): Array<DependabotEntry | null> =>
  seq.items.map((item) => (isMap(item) ? entryOf(item.toJS(doc)) : null));

/** What to add under a cooldown so that it holds back everything but `name`. */
const excludeSnippet = (name: string): string =>
  `exclude:\n  - ${/^[@!&*]/.test(name) ? JSON.stringify(name) : name}`;

/**
 * What a person has to add to the entries that still have a cooldown which holds back the docs
 * package (the npm entry of the site folder) or the shared workflows (the github-actions entry, with
 * `actions`), judged on the text of the file after `ensureDependabotEntries`. Each item completes the
 * sentence "<the file>: <item>"; the lines after the first are the YAML to add.
 */
export function cooldownAdvice(text: string, o: { site: string; actions: boolean }): string[] {
  const directory = `/${o.site}`;
  const advice: string[] = [];
  for (const entry of readDependabotEntries(text).entries) {
    if (!entry.cooldown.present) continue;
    if (entry.ecosystem === "npm" && entry.directories.includes(directory)) {
      if (!entry.cooldown.excludes.includes(PACKAGE)) {
        advice.push(
          `the npm entry for ${directory} has a cooldown that does not exclude "${PACKAGE}", so a release of the package would wait for it; add this under its cooldown:\n${excludeSnippet(PACKAGE)}`,
        );
      }
    } else if (
      o.actions &&
      entry.ecosystem === "github-actions" &&
      entry.directories.includes("/")
    ) {
      if (!entry.cooldown.excludes.includes(REPOSITORY)) {
        advice.push(
          `the github-actions entry has a cooldown that does not exclude ${REPOSITORY}, so a release of the shared workflows would wait for it; add this under its cooldown:\n${excludeSnippet(REPOSITORY)}`,
        );
      }
    }
  }
  return advice;
}

/** A change to the text of the file: `remove` characters at `at` are replaced by `insert`. */
interface Edit {
  at: number;
  remove: number;
  insert: string;
}

/** The end of the line that a scalar ends on, when only blanks or a comment follow it there; null otherwise. */
function lineEndAfter(text: string, scalar: unknown): number | null {
  const range = isScalar(scalar) ? scalar.range : null;
  if (range === null || range === undefined) return null;
  const newline = text.indexOf("\n", range[1]);
  const end = newline < 0 ? text.length : newline + 1;
  return /^[ \t]*(?:#[^\r\n]*)?\r?\n?$/.test(text.slice(range[1], end)) ? end : null;
}

/** The last scalar of a block node (the last value of the last pair, the last item of a list); null when there is none to find. */
function lastScalar(node: unknown): unknown {
  if (isScalar(node)) return node;
  if (isMap(node) && !node.flow) return lastScalar(node.items.at(-1)?.value);
  if (isSeq(node) && !node.flow) return lastScalar(node.items.at(-1));
  return null;
}

/** The insertion of whole lines at `at`, the start of a line or the end of a text that lacks its last line break. */
const lineEdit = (text: string, at: number, lines: string): Edit => ({
  at,
  remove: 0,
  insert: at === text.length && !text.endsWith("\n") ? `\n${lines}` : lines,
});

/**
 * The edit that puts `name` under the `cooldown.exclude` of the entry `item` of `text`: a new `exclude:` list
 * after the last line of a block cooldown, or one more item at the end of its block `exclude:` list.
 * "none" when the entry has no cooldown or excludes `name` already; "hand" when its cooldown is written in a
 * way that cannot be extended without rewriting it (a flow mapping or list, an empty `exclude:`).
 */
function cooldownExclusion(item: YAMLMap, text: string, name: string): Edit | "none" | "hand" {
  const cooldown = item.get("cooldown", true);
  if (!isMap(cooldown)) return "none";
  const quoted = JSON.stringify(name);
  const exclude = cooldown.get("exclude", true);
  if (isSeq(exclude) && exclude.items.some((entry) => isScalar(entry) && entry.value === name)) {
    return "none";
  }
  if (cooldown.flow) return "hand";
  const indentOf = (start: number | undefined, pattern: RegExp): string | null => {
    if (start === undefined) return null;
    const line = text.slice(text.lastIndexOf("\n", start - 1) + 1, start);
    return pattern.exec(line)?.[1] ?? null;
  };
  if (exclude === undefined) {
    const key = cooldown.items[0]?.key;
    const indent = indentOf(isScalar(key) ? key.range?.[0] : undefined, /^( *)$/);
    const at = lineEndAfter(text, lastScalar(cooldown));
    if (indent === null || at === null) return "hand";
    return lineEdit(text, at, `${indent}exclude:\n${indent}  - ${quoted}\n`);
  }
  if (isSeq(exclude) && !exclude.flow && exclude.items.length > 0) {
    const first = exclude.items[0];
    const indent = indentOf(isScalar(first) ? first.range?.[0] : undefined, /^( *)-[ \t]+$/);
    const at = lineEndAfter(text, exclude.items.at(-1));
    if (indent === null || at === null) return "hand";
    return lineEdit(text, at, `${indent}- ${quoted}\n`);
  }
  return "hand";
}

/** The Document API twin of `cooldownExclusion`, for a file that is rewritten as a whole anyway; true when it added `name`. */
function excludeFromCooldown(item: YAMLMap, doc: Document, name: string): boolean {
  const cooldown = item.get("cooldown", true);
  if (!isMap(cooldown)) return false;
  const exclude = cooldown.get("exclude", true);
  if (isSeq(exclude)) {
    if (exclude.items.some((entry) => isScalar(entry) && entry.value === name)) return false;
    exclude.add(doc.createNode(name));
    return true;
  }
  if (exclude !== undefined) return false;
  cooldown.set("exclude", doc.createNode([name]));
  return true;
}

/** `text` with `edits` applied; the edits are positions in `text` and must not overlap. */
function applyEdits(text: string, edits: Edit[]): string {
  let result = text;
  for (const edit of [...edits].sort((a, b) => b.at - a.at)) {
    result = `${result.slice(0, edit.at)}${edit.insert}${result.slice(edit.at + edit.remove)}`;
  }
  return result;
}

/**
 * The full-line comments that talk about the site folder and name Bun, now that its entry is npm's: "Bun"
 * becomes "npm" (the same length, so no position moves). Other comments, and every other mention of bun
 * (`bun.lock`, a bun entry for another folder), stay as they are.
 */
function refreshBunComments(text: string, site: string): { text: string; changed: boolean } {
  const lines = text.split("\n");
  let changed = false;
  for (let start = 0; start < lines.length;) {
    if (!/^[ \t]*#/.test(lines[start] ?? "")) {
      start += 1;
      continue;
    }
    let end = start;
    while (end < lines.length && /^[ \t]*#/.test(lines[end] ?? "")) end += 1;
    const block = lines.slice(start, end);
    if (block.join("\n").includes(`${site}/`) && block.some((line) => /\bBun\b/.test(line))) {
      for (let i = start; i < end; i += 1) {
        const line = lines[i] ?? "";
        const next = line.replace(/\bBun\b(?!\.lock)/g, "npm");
        if (next !== line) {
          lines[i] = next;
          changed = true;
        }
      }
    }
    start = end;
  }
  return { text: lines.join("\n"), changed };
}

/**
 * Adds what a docs shell needs to a dependabot.yml and says what it did:
 *
 * - the npm entry for `/<site>` unless an npm entry covers that directory (an existing `bun` entry
 *   that covers only that directory is converted to `npm` in place: the shell's lockfile is
 *   `package-lock.json`, so the ecosystem is npm, and a leftover bun entry fails on every run);
 * - with `actions`, the github-actions entry for `/` unless one covers `/`.
 *
 * `text` null is no file: the result is a new file. Everything already in the file is kept as it was.
 * Throws DependabotShapeError when the file is not in a shape that can be edited safely.
 */
export function ensureDependabotEntries(
  text: string | null,
  o: { site: string; actions: boolean },
): { text: string; changes: string[] } {
  const problem = siteDirProblem(o.site);
  if (problem !== null) throw new Error(problem);
  const directory = `/${o.site}`;
  const npm = npmSnippet(o.site);
  const actions = actionsSnippet();
  const handSnippet = (needNpm: boolean, needActions: boolean): string =>
    [...(needNpm ? [npm] : []), ...(needActions ? [actions] : [])].join("\n");
  const shape = (why: string, needNpm: boolean, needActions: boolean): DependabotShapeError =>
    new DependabotShapeError(why, handSnippet(needNpm, needActions));

  const changes: string[] = [];
  const addedNpm = `added the npm entry for ${directory}`;
  const addedActions = "added the github-actions entry for /";

  if (text === null || text.trim() === "") {
    const body = ["version: 2", "updates:", npm.trimEnd()];
    if (o.actions) body.push("", actions.trimEnd());
    changes.push(addedNpm);
    if (o.actions) changes.push(addedActions);
    return { text: `${body.join("\n")}\n`, changes };
  }

  const doc = parseDocument(text);
  const failure = doc.errors[0];
  if (failure !== undefined) {
    throw shape(`is not valid YAML (${failure.message.split("\n")[0] ?? ""})`, true, o.actions);
  }
  const eol = eolOf(text);
  const root = doc.contents;
  const finish = (result: string, list: string[]): { text: string; changes: string[] } => ({
    text: eol === "\n" ? result : result.replace(/\r?\n/g, eol),
    changes: list,
  });

  // Only comments: the file has no top-level key yet.
  if (root === null) {
    const base = hasNewline(text) ? text : `${text}${eol}`;
    const body = ["version: 2", "updates:", npm.trimEnd()];
    if (o.actions) body.push("", actions.trimEnd());
    changes.push(addedNpm);
    if (o.actions) changes.push(addedActions);
    return { text: `${base}${eol}${body.join(eol)}${eol}`, changes };
  }
  if (!isMap(root)) throw shape("is not a YAML mapping", true, o.actions);

  const updates = root.get("updates", true);
  const none =
    updates === undefined || updates === null || (isScalar(updates) && updates.value === null);
  if (!none && !isSeq(updates)) throw shape("has an `updates` that is not a list", true, o.actions);

  const parsed = isSeq(updates) ? entriesOfSeq(updates, doc) : [];
  if (parsed.some((entry) => entry === null)) {
    throw shape(
      "has an entry in `updates` that is not a mapping with a package-ecosystem",
      true,
      o.actions,
    );
  }
  const entries = parsed as DependabotEntry[];

  const covers = (entry: DependabotEntry, where: string): boolean =>
    entry.directories.includes(where);
  const hasNpm = entries.some((e) => e.ecosystem === "npm" && covers(e, directory));
  const bunIndex = entries.findIndex(
    (e) => e.ecosystem === "bun" && e.directories.length === 1 && covers(e, directory),
  );
  const hasActions = entries.some((e) => e.ecosystem === "github-actions" && covers(e, "/"));
  const needNpm = !hasNpm && bunIndex < 0;
  const needActions = o.actions && !hasActions;
  const convert = !hasNpm && bunIndex >= 0;
  if (!needNpm && !needActions && !convert) return { text, changes: [] };

  let result = text;
  if (convert) changes.push(`converted the bun entry for ${directory} to npm`);
  if (needNpm) changes.push(addedNpm);
  if (needActions) changes.push(addedActions);

  const additions = [...(needNpm ? [npm] : []), ...(needActions ? [actions] : [])];

  // The conversion edits the characters `bun` in place (three letters for three letters) and may add
  // the package to the entry's cooldown; the parsed document is read again afterwards, because the
  // insertion below needs the positions of the text as it is then.
  if (isSeq(updates) && updates.items.length > 0 && !updates.flow) {
    let list: YAMLSeq = updates;
    if (convert) {
      const item = updates.items[bunIndex];
      const value = isMap(item) ? (item as YAMLMap).get("package-ecosystem", true) : null;
      const range = isScalar(value) ? value.range : null;
      if (range === null || range === undefined || !isMap(item)) {
        throw shape("has a bun entry that cannot be converted in place", needNpm, needActions);
      }
      const edits: Edit[] = [
        {
          at: range[0],
          remove: range[1] - range[0],
          insert: text.slice(range[0], range[1]).replace("bun", "npm"),
        },
      ];
      const exclusion = cooldownExclusion(item, text, PACKAGE);
      if (exclusion !== "none" && exclusion !== "hand") {
        edits.push(exclusion);
        changes.push(`excluded ${PACKAGE} from the cooldown of the npm entry for ${directory}`);
      }
      result = applyEdits(text, edits);
      const refreshed = refreshBunComments(result, o.site);
      if (refreshed.changed) {
        result = refreshed.text;
        changes.push("brought the comments that named Bun up to date");
      }
      const live = parseDocument(result).get("updates", true);
      if (!isSeq(live)) throw shape("could not be extended", needNpm, needActions);
      list = live;
    }
    if (additions.length === 0) return finish(result, changes);

    const first = list.items[0];
    const start = isMap(first) ? first.range?.[0] : undefined;
    const rangeEnd = list.range?.[1];
    if (start === undefined || rangeEnd === undefined) {
      throw shape("has a list of entries whose position cannot be found", needNpm, needActions);
    }
    const lineStart = result.lastIndexOf("\n", start - 1) + 1;
    const dash = /^( *)-[ \t]+$/.exec(result.slice(lineStart, start));
    if (dash === null) {
      throw shape(
        "has a list of entries in a layout that cannot be extended safely",
        needNpm,
        needActions,
      );
    }
    // After the last entry: the end of the list, moved to the end of its line.
    let end = rangeEnd;
    if (end < result.length && result[end - 1] !== "\n") {
      const newline = result.indexOf("\n", end);
      end = newline < 0 ? result.length : newline + 1;
    }
    let before = result.slice(0, end);
    const after = result.slice(end);
    if (!hasNewline(before)) before += "\n";
    const block = reindent(additions.join("\n"), (dash[1] ?? "").length);
    const separator = before.endsWith("\n\n") ? "" : "\n";
    const tail = after === "" || after.startsWith("\n") || after.startsWith("\r\n") ? "" : "\n";
    return finish(`${before}${separator}${block}${tail}${after}`, changes);
  }

  // No `updates:` key at all: the key and the snippets are appended.
  if (updates === undefined) {
    const base = hasNewline(result) ? result : `${result}\n`;
    const separator = base.endsWith("\n\n") ? "" : "\n";
    return finish(`${base}${separator}updates:\n${additions.join("\n")}`, changes);
  }

  // `updates: []`, `updates:` with nothing, or a flow list: the Document API replaces the list.
  const snippetSeq = parseDocument(`updates:\n${additions.join("\n")}`).get("updates", true);
  if (additions.length > 0 && !isSeq(snippetSeq))
    throw shape("could not be extended", needNpm, needActions);
  if (isSeq(updates) && updates.items.length > 0) {
    if (convert) {
      const item = updates.items[bunIndex];
      if (isMap(item)) {
        item.set("package-ecosystem", "npm");
        if (excludeFromCooldown(item, doc, PACKAGE)) {
          changes.push(`excluded ${PACKAGE} from the cooldown of the npm entry for ${directory}`);
        }
      }
    }
    updates.flow = false;
    if (isSeq(snippetSeq)) {
      for (const added of snippetSeq.items) updates.items.push(added);
    }
  } else {
    (root as YAMLMap).set("updates", snippetSeq);
  }
  const written = doc.toString({ lineWidth: 0 });
  if (!convert) return finish(written, changes);
  const refreshed = refreshBunComments(written, o.site);
  if (refreshed.changed) changes.push("brought the comments that named Bun up to date");
  return finish(refreshed.text, changes);
}
