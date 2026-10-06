// The files a shell is made of, as `init` and `upgrade` write them, and the reading of the caller
// workflows that `doctor` needs (sections 2 and 4.1 of the architecture decision record):
//
//   - rendering of `scaffold/*` (the two caller workflows, the Dependabot snippets, .gitignore);
//   - a plan of file changes (what would be created or updated) with a unified diff, so that
//     `--dry-run` can show everything and a real run writes exactly what it showed;
//   - an inspection of a caller workflow (triggers, permissions, the pinned `uses:` lines);
//   - the list of settings that a maintainer still has to make outside the repository (2.5).
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parse } from "yaml";
import { isInside } from "./fsutil.js";
import { packageRoot, REPOSITORY } from "./package-info.js";
import { bareVersion, COMMIT } from "./pin.js";

// ---- names and paths ----

/** The folder name that the reusable workflow accepts as `site-directory` (docs-build.yml validates the same pattern). */
export const SITE_DIR = /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/;

/** Why `site` (a path relative to the repository root, `/`-separated) cannot be a site folder; null when it can. */
export function siteDirProblem(site: string): string | null {
  if (
    !SITE_DIR.test(site) ||
    site.includes("..") ||
    site.split("/").some((part) => part === "" || part === ".")
  ) {
    return `"${site}" is not a usable site folder: it must be a relative path of letters, digits, "_", "-" and "." (the reusable workflow accepts nothing else), without "..", for example docs-site`;
  }
  return null;
}

/** `./docs-site/` as `docs-site`; null when the text is not a relative folder name at all. */
export function cleanSiteDir(text: string): string | null {
  const site = text
    .trim()
    .replace(/^(?:\.\/)+/, "")
    .replace(/\/+$/, "");
  return site === "" ? null : site;
}

/** Characters a docs folder may have so that it can sit in a quoted `paths:` glob and mean itself. */
const DOCS_SEGMENT = /^[A-Za-z0-9_.][A-Za-z0-9_. -]*$/;

/**
 * Why `docs` (the Markdown folder relative to the repository root, `/`-separated; "" is the root
 * itself) cannot be put into a workflow path filter; null when it can.
 */
export function docsPathProblem(docs: string): string | null {
  if (docs === "") return null;
  const parts = docs.split("/");
  if (
    parts.some((part) => part === "" || part === "." || part === ".." || !DOCS_SEGMENT.test(part))
  ) {
    return `the docs folder "${docs}" has characters that a workflow path filter cannot take literally (use letters, digits, spaces, "_", "-" and "."), or is not inside the repository`;
  }
  return null;
}

/** The workflow `paths:` glob that covers a repository-relative folder. */
export function folderGlob(folder: string): string {
  return folder === "" ? "**" : `${folder}/**`;
}

// ---- the scaffold ----

export type ScaffoldFile =
  | "docs.yml"
  | "docs-publish.yml"
  | "dependabot-npm.yml"
  | "dependabot-actions.yml"
  | "gitignore";

/** The text of a file of the package's `scaffold/` folder, tokens and all. */
export function readScaffold(file: ScaffoldFile): string {
  return readFileSync(join(packageRoot, "scaffold", file), "utf8");
}

/** Replaces the `@@TOKEN@@` markers of a template. A function replacement, so `$` in a value is not special. */
export function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/@@([A-Z]+)@@/g, (marker: string, key: string) => values[key] ?? marker);
}

/**
 * Renders `scaffold/docs.yml` or `scaffold/docs-publish.yml`. `docs` and `site` are folders relative
 * to the repository root (`docs`, `docs-site`; the docs folder may be "" for the root itself), `sha` is
 * the 40-character commit of the release and `version` its number (`0.1.0` or `v0.1.0`). Throws on
 * values that could not be put into the workflow safely.
 */
export function renderScaffold(
  file: "docs.yml" | "docs-publish.yml",
  v: { docs: string; site: string; sha: string; version: string },
): string {
  const siteProblem = siteDirProblem(v.site);
  if (siteProblem !== null) throw new Error(siteProblem);
  const docs = v.docs === "." ? "" : v.docs;
  const docsProblem = docsPathProblem(docs);
  if (docsProblem !== null) throw new Error(docsProblem);
  if (!COMMIT.test(v.sha)) throw new Error(`"${v.sha}" is not a full 40-character commit id`);
  const bare = bareVersion(v.version);
  if (bare === null) throw new Error(`"${v.version}" is not a version (MAJOR.MINOR.PATCH)`);
  const template = readScaffold(file);
  // The Markdown folder may be the repository itself: the glob is then `**`, not `/**`.
  const text = docs === "" ? template.replaceAll(`"@@DOCS@@/**"`, `"**"`) : template;
  return fillTemplate(text, { DOCS: docs, SITE: v.site, SHA: v.sha, VERSION: `v${bare}` });
}

// ---- planning file changes ----

export interface FileChange {
  /** Relative to the repository root, `/`-separated. */
  path: string;
  action: "create" | "update" | "unchanged";
  before: string | null;
  after: string;
  /** Why, in a few words: shown next to the path. */
  note?: string;
}

/** The text of a file, or null when it does not exist; throws when the path is a folder. */
export function readTextOrNull(path: string): string | null {
  if (!existsSync(path)) return null;
  if (lstatSync(path).isDirectory()) throw new Error(`${path} is a folder, not a file`);
  return readFileSync(path, "utf8");
}

/** The change that makes `path` hold `after`, given what it holds now (null: it does not exist). */
export function planChange(
  path: string,
  before: string | null,
  after: string,
  note?: string,
): FileChange {
  const action = before === null ? "create" : before === after ? "unchanged" : "update";
  return { path, action, before, after, ...(note === undefined ? {} : { note }) };
}

/**
 * Writes every create/update of `changes` under `repoRoot`, all or nothing as far as it can tell
 * beforehand: a path outside the repository, or one that is (or lies below) a symbolic link, is
 * refused before anything is written, so that a link committed to a repository cannot make init or
 * upgrade overwrite a file somewhere else (the real-bytes rule of section 1.5).
 */
export function applyChanges(repoRoot: string, changes: FileChange[]): void {
  const todo = changes.filter((change) => change.action !== "unchanged");
  const root = resolve(repoRoot);
  for (const change of todo) {
    const target = resolve(root, change.path);
    if (!isInside(root, target, { strict: true })) {
      throw new Error(`refusing to write ${change.path}: it is not inside ${repoRoot}`);
    }
    let at = root;
    for (const part of relative(root, target).split(sep)) {
      at = join(at, part);
      let stat;
      try {
        stat = lstatSync(at);
      } catch {
        break; // this part and everything below it does not exist yet
      }
      if (stat.isSymbolicLink()) {
        throw new Error(
          `refusing to write ${change.path}: ${relative(root, at).split(sep).join("/")} is a symbolic link`,
        );
      }
    }
  }
  for (const change of todo) {
    const target = resolve(root, change.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, change.after);
  }
}

const splitLines = (text: string): string[] =>
  text === "" ? [] : text.replace(/\r?\n$/, "").split(/\r?\n/);

interface Op {
  kind: " " | "-" | "+";
  text: string;
  /** How many lines of the old and the new text come before this one. */
  a: number;
  b: number;
}

/** A line diff by longest common subsequence; small files only (everything this module diffs is). */
function diffOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const ops: Op[] = [];
  if (n * m > 16_000_000) {
    a.forEach((text, i) => ops.push({ kind: "-", text, a: i, b: 0 }));
    b.forEach((text, j) => ops.push({ kind: "+", text, a: n, b: j }));
    return ops;
  }
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    const row = lcs[i]!;
    const below = lcs[i + 1]!;
    for (let j = m - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? below[j + 1]! + 1 : Math.max(below[j]!, row[j + 1]!);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      ops.push({ kind: " ", text: a[i]!, a: i, b: j });
      i++;
      j++;
    } else if (j < m && (i === n || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) {
      ops.push({ kind: "+", text: b[j]!, a: i, b: j });
      j++;
    } else {
      ops.push({ kind: "-", text: a[i]!, a: i, b: j });
      i++;
    }
  }
  return ops;
}

/**
 * A unified diff of one file as lines of text (no trailing newlines), three lines of context.
 * `before` null is a new file. Empty when nothing differs.
 */
export function unifiedDiff(
  path: string,
  before: string | null,
  after: string,
  context = 3,
): string[] {
  const ops = diffOps(splitLines(before ?? ""), splitLines(after));
  const changed = ops.flatMap((op, index) => (op.kind === " " ? [] : [index]));
  if (changed.length === 0) return [];
  const ranges: Array<[number, number]> = [];
  for (const index of changed) {
    const from = Math.max(0, index - context);
    const to = Math.min(ops.length - 1, index + context);
    const last = ranges.at(-1);
    if (last !== undefined && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else ranges.push([from, to]);
  }
  const lines = [`--- ${before === null ? "/dev/null" : `a/${path}`}`, `+++ b/${path}`];
  for (const [from, to] of ranges) {
    const hunk = ops.slice(from, to + 1);
    const first = hunk[0]!;
    const oldCount = hunk.filter((op) => op.kind !== "+").length;
    const newCount = hunk.filter((op) => op.kind !== "-").length;
    const oldStart = oldCount === 0 ? first.a : first.a + 1;
    const newStart = newCount === 0 ? first.b : first.b + 1;
    lines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const op of hunk) lines.push(`${op.kind}${op.text}`);
  }
  return lines;
}

// ---- reading a caller workflow (doctor) ----

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

/** A job of a caller workflow that uses a reusable workflow of this repository. */
export interface WorkflowUse {
  job: string;
  /** The workflow file, `docs-build.yml`. */
  workflow: string;
  /** What follows `@`: a commit, a tag or a branch. */
  ref: string;
  /** The text of the trailing `# vX.Y.Z` comment, or null. */
  comment: string | null;
  /** The version of that comment without its `v`, or null. */
  version: string | null;
}

export interface CallerJob {
  id: string;
  uses: string | null;
  if: string | null;
  with: Record<string, unknown>;
  /** The names granted `write` (`pages`, `id-token`, ...), or `write-all`; empty when the job grants none. */
  writes: string[];
}

export interface CallerInfo {
  /** Set when the text is not YAML (nothing else is filled in then). */
  error: string | null;
  /** The events in `on:`, whichever of its three spellings was used. */
  triggers: string[];
  /** `on.<event>.paths` per event. */
  paths: Record<string, string[]>;
  /** `on.<event>.branches` per event. */
  branches: Record<string, string[]>;
  /** Names granted `write` by the workflow-level `permissions:`. */
  writes: string[];
  jobs: CallerJob[];
  /** Every job that calls a reusable workflow of Avunu/docusystem. */
  uses: WorkflowUse[];
}

const writesOf = (permissions: unknown): string[] => {
  if (permissions === "write-all") return ["write-all"];
  if (!isRecord(permissions)) return [];
  return Object.entries(permissions).flatMap(([name, level]) => (level === "write" ? [name] : []));
};

const USES = new RegExp(String.raw`^${REPOSITORY}/\.github/workflows/([^@\s]+)@(\S+)$`);

/** Reads what `doctor` checks of a caller workflow. Never throws. */
export function inspectCaller(text: string): CallerInfo {
  const info: CallerInfo = {
    error: null,
    triggers: [],
    paths: {},
    branches: {},
    writes: [],
    jobs: [],
    uses: [],
  };
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (error) {
    info.error = (error as Error).message.split("\n")[0] ?? "not YAML";
    return info;
  }
  if (!isRecord(doc)) {
    info.error = "not a workflow (the top level is not a mapping)";
    return info;
  }
  const on = doc.on;
  if (typeof on === "string") info.triggers = [on];
  else if (Array.isArray(on)) info.triggers = strings(on);
  else if (isRecord(on)) {
    info.triggers = Object.keys(on);
    for (const [event, config] of Object.entries(on)) {
      if (!isRecord(config)) continue;
      info.paths[event] = strings(config.paths);
      info.branches[event] = strings(config.branches);
    }
  }
  info.writes = writesOf(doc.permissions);
  const lines = text.split(/\r?\n/);
  const jobs = isRecord(doc.jobs) ? doc.jobs : {};
  for (const [id, job] of Object.entries(jobs)) {
    if (!isRecord(job)) continue;
    const uses = typeof job.uses === "string" ? job.uses : null;
    info.jobs.push({
      id,
      uses,
      if: typeof job.if === "string" ? job.if : job.if === undefined ? null : String(job.if),
      with: isRecord(job.with) ? job.with : {},
      writes: writesOf(job.permissions),
    });
    const match = uses === null ? null : USES.exec(uses);
    if (match === null || uses === null) continue;
    const line = lines.find((l) => l.includes("uses:") && l.includes(uses)) ?? "";
    const comment = /#\s*(\S+)/.exec(line.slice(line.indexOf(uses) + uses.length))?.[1] ?? null;
    info.uses.push({
      job: id,
      workflow: match[1]!,
      ref: match[2]!,
      comment,
      version: comment === null ? null : bareVersion(comment),
    });
  }
  return info;
}

// ---- what a maintainer still has to do ----

/**
 * The settings that live in GitHub, DNS and avunu.net (section 2.5): no pull request can make them,
 * so `init` and `doctor` print them with the values of this repository.
 *
 * The domain verification comes before the DNS record on purpose: a record that points at
 * `avunu.github.io` while no GitHub organization has verified the domain lets any other account
 * claim the name once this repository stops serving it (the subdomain takeover that
 * MAINTAINING.md describes). The last step is about the end of the site's life for the same reason.
 */
export function maintainerSteps(config: {
  domain: string;
  slug: string;
  repo?: string | undefined;
  branch?: string | undefined;
}): string[] {
  const suffix = ".avunu.net";
  const label = config.domain.endsWith(suffix)
    ? config.domain.slice(0, -suffix.length)
    : config.domain;
  // GitHub protects the verified domain and its immediate subdomains only, so a nested name needs
  // its own verification.
  const verified =
    config.domain.endsWith(suffix) && !label.includes(".") ? suffix.slice(1) : config.domain;
  const owner = /^https:\/\/github\.com\/([^/]+)\//.exec(config.repo ?? "")?.[1] ?? "<ORG>";
  return [
    "GitHub Pages: Settings > Pages > Source: GitHub Actions",
    `Verify ${verified} once for the ${owner} GitHub organization, before the custom domain and the DNS record (organization Settings > Pages > Add a domain; TXT record _github-pages-challenge-${owner}.${verified}). Without it, another GitHub account can claim ${config.domain} if this site is unpublished while its DNS record remains`,
    `Custom domain: ${config.domain} (Settings > Pages); turn on "Enforce HTTPS" once the certificate exists`,
    `DNS: CNAME ${label} -> avunu.github.io (DNS only until the certificate exists)`,
    "Repository variable: DOCS_SITE_ENABLED = true (Settings > Secrets and variables > Actions > Variables); until then the workflows build and check the site but do not publish it",
    `Branch protection on ${config.branch ?? "the default branch"}: every push to it publishes the site`,
    `avunu.net catalog: docs: https://${config.domain} in the entry for ${config.slug}`,
    "In the repository: link the documentation from the README, and exclude docs/ from formatters and hooks that rewrite Markdown (for example a copyright stamp above the front matter)",
    `Later, when the site is retired or its domain changes (Pages unpublished, repository deleted, archived or renamed): delete the CNAME of the old domain (now: ${label}) and its docs: line in the catalog in the same change, so that no record is left pointing at avunu.github.io`,
  ];
}
