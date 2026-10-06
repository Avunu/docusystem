// Stages docs/ for Jx (step 5 of the pipeline): copies the documentation folder to .generated/docs
// (the folder the `docs` content type reads) and fixes the two things Jx cannot.
//
// 1. Links to files of the repository that are not pages. A README copied into docs/ is full of
//    them, written relative to the repository root (`worker/README.md`, `docs/chat.md`, `LICENSE`),
//    and a README that was written for docs/ has them as `../CONTRIBUTING.md`. Jx rewrites a link
//    only when it points at a published page; a link to a Markdown file it does not publish renders
//    as plain text, and one to any other file keeps its href and 404s. Here, before Jx reads the
//    files, every link or image whose target exists in the repository is rewritten:
//      - to a file that is outside docs/        -> a GitHub URL (/blob/, /tree/, or /raw/ for an image)
//      - written from the root, inside docs/    -> the path relative to the file (`docs/chat.md` from
//        docs/README.md becomes `chat.md`), so Jx can resolve it as a page
//    A link that resolves relative to the file, inside docs/, is left alone. One that resolves
//    nowhere is left alone too: Jx reports it, and a strict build fails on it.
// 2. A leading HTML comment before the frontmatter. Hooks that stamp a copyright line into every
//    Markdown file (Frappe apps have one) put it before the `---`, which turns the frontmatter into
//    page text. The comment is moved behind the frontmatter.
//
// Which files are copied is decided by fsutil.walkFiles, so the symlink policy of section 4.1 holds
// here: a link to a file inside the repository is followed (its bytes are copied), any other link is
// skipped and reported in `StageResult.skipped` (an error under strict, decided by the pipeline).
// Dot files and folders and node_modules are never copied.
//
// The copy is incremental (a file is written only when its bytes changed, files that left docs/ are
// removed), so the dev server's file watcher sees what the author changed and nothing else, and
// running it twice in a row changes nothing.
import {
  type Stats,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { moveLeadingComment } from "./frontmatter.js";
import { ensureRealDir, isInside, removeInside, walkFiles } from "./fsutil.js";
import { destinations, lines, type Destination } from "./markdown.js";
import { githubUrl } from "./repo-links.js";
import type { DocsConfig, Paths, StagedLink, StageResult } from "./types.js";

export interface StageOptions {
  /** The repository's docs/ folder. */
  source: string;
  /** Where the copy goes (.generated/docs). */
  dest: string;
  /** The repository root, to find the files that documents link to. */
  repoRoot: string;
  /** https://github.com/<owner>/<name> */
  repoUrl: string;
  branch: string;
  /** The site folder, so that the site's own dist/ is refused by the symlink policy. */
  siteDir?: string;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

const encodePath = (path: string) =>
  path
    .split("/")
    .map((part) => encodeURIComponent(part).replaceAll("(", "%28").replaceAll(")", "%29"))
    .join("/");

/** A destination that must not be touched: empty, an anchor, a scheme, a protocol-relative or site-absolute address. */
function untouchable(value: string): boolean {
  return (
    value === "" ||
    value.startsWith("#") ||
    value.startsWith("/") ||
    value.startsWith("?") ||
    /^[a-z][a-z0-9+.-]*:/i.test(value)
  );
}

/**
 * Where a link written in `file` (a path inside docs/) should point, or null to leave it alone.
 * `image` selects a raw GitHub URL for a file outside docs/.
 */
export function resolveLink(
  value: string,
  file: string,
  image: boolean,
  options: StageOptions,
  memo?: LinkMemo,
): string | null {
  if (untouchable(value)) return null;
  if (memo === undefined) return resolveUncached(value, file, image, options);
  // The answer depends on the file only through its folder.
  const key = `${posix.dirname(file)}\0${image ? "i" : "l"}\0${value}`;
  const known = memo.get(key);
  if (known !== undefined) return known;
  const answer = resolveUncached(value, file, image, options);
  memo.set(key, answer);
  return answer;
}

/**
 * What staging has already worked out in one run: the same link, written in files of the same
 * folder, finds the same file. A run builds its own (the file system may change between runs).
 */
export type LinkMemo = Map<string, string | null>;

function resolveUncached(
  value: string,
  file: string,
  image: boolean,
  options: StageOptions,
): string | null {
  const cut = value.search(/[?#]/);
  const pathPart = cut === -1 ? value : value.slice(0, cut);
  const suffix = cut === -1 ? "" : value.slice(cut);
  const decoded = safeDecode(pathPart);
  const here = dirname(join(options.source, ...file.split("/")));

  const near = resolve(here, decoded);
  if (existsSync(near)) {
    // It resolves where the author wrote it. Inside docs/ that is Jx's business, unless the path
    // climbs out of docs/ and comes back in (`../docs/chat.md`): Jx reads that as leaving the
    // collection, so it is written as the page's own relative path. Outside docs/ it is GitHub's.
    if (isInside(options.source, near)) {
      const dir = posix.dirname(file) === "." ? "" : posix.dirname(file);
      const logical = posix.normalize(posix.join(dir, decoded));
      if (!(logical === ".." || logical.startsWith("../"))) return null;
      const rel = relative(here, near).split(sep).join("/");
      return `${rel === "" ? "./" : encodePath(rel)}${suffix}`;
    }
    if (!isInside(options.repoRoot, near)) return null;
    return github(near, image, options) + suffix;
  }
  const root = resolve(options.repoRoot, decoded);
  if (!isInside(options.repoRoot, root) || !existsSync(root)) return null;
  if (isInside(options.source, root)) {
    // Written from the repository root, but the file is in docs/: make it relative to this file.
    const rel = relative(here, root).split(sep).join("/");
    return `${rel === "" ? "./" : encodePath(rel)}${suffix}`;
  }
  return github(root, image, options) + suffix;
}

function github(absolute: string, image: boolean, options: StageOptions): string {
  const repoPath = relative(options.repoRoot, absolute).split(sep).join("/");
  return githubUrl(options, repoPath, image).replaceAll("(", "%28").replaceAll(")", "%29");
}

/**
 * Rewrites the link and image destinations of one Markdown file (`file` is its path inside docs/)
 * and moves a leading comment behind the frontmatter. `text` is `source` itself, byte for byte, when
 * there was nothing to do. Links in code (fences and spans) are never touched.
 */
export function stageMarkdown(
  source: string,
  file: string,
  options: StageOptions,
  memo?: LinkMemo,
): { text: string; links: StagedLink[]; comment: boolean } {
  const moved = moveLeadingComment(source);
  const text = moved ?? source;
  const links: StagedLink[] = [];
  const out: string[] = [];
  for (const line of lines(text)) {
    if (line.code || !/\]\(/.test(line.text)) {
      out.push(line.text);
      continue;
    }
    let rewritten = line.text;
    const found: Destination[] = destinations(line.text);
    const here: StagedLink[] = [];
    // Back to front, so earlier offsets stay valid.
    for (const dest of found.toReversed()) {
      const to = resolveLink(dest.value, file, dest.image, options, memo);
      if (to === null || to === dest.value) continue;
      here.push({ file, line: line.index + 1, from: dest.value, to });
      // `to` is always percent-encoded, so it needs no angle brackets; inside them it is fine too.
      rewritten = rewritten.slice(0, dest.start) + to + rewritten.slice(dest.end);
    }
    links.push(...here.toReversed());
    out.push(rewritten);
  }
  if (links.length === 0) return { text: moved ?? source, links, comment: moved !== null };
  // Put each line back with the line ending it had (a file may mix them).
  const endings = text.split(/(\r?\n)/).filter((_, i) => i % 2 === 1);
  let rewritten = out[0] ?? "";
  for (const [i, line] of out.slice(1).entries()) rewritten += (endings[i] ?? "\n") + line;
  return { text: rewritten, links, comment: moved !== null };
}

/** The lstat of a path, or null when nothing is there. */
function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/**
 * Writes `data` to `path` unless the file already holds exactly these bytes. Whatever else is at
 * `path` (a symbolic link, a read-only file) is replaced, never written through. Returns whether it
 * wrote.
 */
function writeIfChanged(path: string, data: Buffer | string): boolean {
  const next = typeof data === "string" ? Buffer.from(data) : data;
  const stat = lstatOrNull(path);
  if (stat?.isFile()) {
    try {
      if (readFileSync(path).equals(next)) return false;
    } catch {
      // unreadable: write over it
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  if (stat !== null) removeInside(path, dirname(path));
  writeFileSync(path, next);
  return true;
}

/**
 * Removes the files and folders of `dest` that are not in `keep` (relative, `/`-separated paths of
 * files), and folders that end up empty. Nothing is followed: a link is a file here, and is removed
 * itself. Returns how many files went.
 */
function prune(dest: string, keep: Set<string>, dir = ""): number {
  let removed = 0;
  const here = dir === "" ? dest : join(dest, ...dir.split("/"));
  for (const entry of readdirSync(here, { withFileTypes: true })) {
    const rel = dir === "" ? entry.name : `${dir}/${entry.name}`;
    const full = join(here, entry.name);
    if (entry.isDirectory()) {
      removed += prune(dest, keep, rel);
      if (readdirSync(full).length === 0) removeInside(full, dest);
    } else if (!keep.has(rel)) {
      removeInside(full, dest);
      removed++;
    }
  }
  return removed;
}

/** Dot files and folders, and node_modules, are never staged. */
const hidden = (rel: string): boolean =>
  rel.split("/").some((part) => part.startsWith(".") || part.toLowerCase() === "node_modules");

/**
 * Copies docs/ to the staging folder, fixing Markdown files on the way. Throws when the source does
 * not exist. A symbolic link that the policy refuses is not copied and comes back in `skipped`.
 */
export function stageDocs(options: StageOptions): StageResult {
  if (!existsSync(options.source)) throw new Error(`${options.source} does not exist`);
  ensureRealDir(options.dest);
  // The site folder is only there to name its dist/, which cannot exist if the folder does not.
  const siteDir =
    options.siteDir !== undefined && existsSync(options.siteDir) ? options.siteDir : undefined;
  const walked = walkFiles(options.source, { repoRoot: options.repoRoot, siteDir });
  const result: StageResult = {
    files: 0,
    written: 0,
    removed: 0,
    links: [],
    comments: [],
    skipped: walked.skipped.filter((entry) => !hidden(entry.path)),
  };
  const staged = walked.files.filter((rel) => !hidden(rel));
  const keep = new Set(staged);
  const memo: LinkMemo = new Map();
  // Prune first: it also clears what is in the way of a file that changed into a folder or back.
  result.removed = prune(options.dest, keep);
  for (const rel of staged) {
    result.files++;
    const from = join(options.source, ...rel.split("/"));
    const to = join(options.dest, ...rel.split("/"));
    const bytes = readFileSync(from);
    let changed: boolean;
    if (/\.md$/i.test(rel)) {
      const source = bytes.toString("utf8");
      const fixed = stageMarkdown(source, rel, options, memo);
      result.links.push(...fixed.links);
      if (fixed.comment) result.comments.push(rel);
      // Unchanged text is written as the bytes it came from (a file that is not UTF-8 stays intact).
      changed = writeIfChanged(to, fixed.text === source ? bytes : fixed.text);
    } else {
      changed = writeIfChanged(to, bytes);
    }
    if (changed) result.written++;
  }
  return result;
}

/** Step 5 of the pipeline (5.1): stages the Markdown folder for the site. */
export function stageSite(
  paths: Pick<Paths, "siteDir" | "repoRoot" | "docsDir" | "stagedDocs">,
  config: Pick<DocsConfig, "repo">,
  branch: string,
): StageResult {
  return stageDocs({
    source: paths.docsDir,
    dest: paths.stagedDocs,
    repoRoot: paths.repoRoot,
    siteDir: paths.siteDir,
    repoUrl: config.repo,
    branch,
  });
}
