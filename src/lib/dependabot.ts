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

  // The conversion edits the characters `bun` in place: three letters for three letters, so the
  // offsets of the parsed document stay valid for the insertion below.
  if (isSeq(updates) && updates.items.length > 0 && !updates.flow) {
    if (convert) {
      const item = updates.items[bunIndex];
      const value = isMap(item) ? (item as YAMLMap).get("package-ecosystem", true) : null;
      const range = isScalar(value) ? value.range : null;
      if (range === null || range === undefined) {
        throw shape("has a bun entry that cannot be converted in place", needNpm, needActions);
      }
      const original = result.slice(range[0], range[1]);
      result = `${result.slice(0, range[0])}${original.replace("bun", "npm")}${result.slice(range[1])}`;
    }
    if (additions.length === 0) return finish(result, changes);

    const first = updates.items[0];
    const start = isMap(first) ? first.range?.[0] : undefined;
    const rangeEnd = updates.range?.[1];
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
      if (isMap(item)) item.set("package-ecosystem", "npm");
    }
    updates.flow = false;
    if (isSeq(snippetSeq)) {
      for (const added of snippetSeq.items) updates.items.push(added);
    }
  } else {
    (root as YAMLMap).set("updates", snippetSeq);
  }
  return finish(doc.toString({ lineWidth: 0 }), changes);
}
