// The file-system rules of docusystem, in one place so that every package obeys the same ones
// (sections 4.1 and 1.5 of the architecture decision record):
//
//   Real bytes only.     What the build publishes are copies, never symbolic links. `copyFile` and
//                        `replaceDir` never create a link and never write through one.
//   Symlink policy.      `walkFiles` follows a symbolic link only when its real path lies inside the
//                        repository and not inside `.git/`, `node_modules/` or the site's own
//                        `.docusystem/` and `dist/`. Everything else is skipped and reported, so that a
//                        pull request cannot publish `/etc/passwd` or a token from `.git/config` by
//                        committing a link.
//   Deletion policy.     The CLI deletes only paths it computed from the site folder.
//                        `removeInside` refuses anything that is not strictly inside the folder it is
//                        given, and anything that would have to be reached through a link.
//
// Node's `fs` only; no dependencies. Paths are native strings; paths that are returned for display or
// for comparison (`walkFiles`) are relative and `/`-separated.
import { createHash } from "node:crypto";
import {
  type Stats,
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { SkippedPath, WalkResult } from "./types.js";

/** Whether `path` is `parent` or lies inside it (strictly inside with `strict`). Purely lexical. */
export function isInside(parent: string, path: string, o: { strict?: boolean } = {}): boolean {
  const rel = relative(resolve(parent), resolve(path));
  if (rel === "") return o.strict !== true;
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

const isMissing = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
};

/** The lstat of a path, or null when it does not exist (a dangling link exists). */
function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

/** Folders that are never published, whatever their depth; their (lower-case) names are the whole rule. */
const NEVER_PUBLISHED = new Map([
  [".git", "a symbolic link into .git"],
  ["node_modules", "a symbolic link into node_modules"],
  [".docusystem", "a symbolic link into .docusystem"],
]);

/**
 * The most directory entries one `walkFiles` call reads before it gives up. A real documentation tree
 * is far below it; a tree of symbolic links that lead to the same folders again and again (each link
 * is followed, so the number of paths doubles with every level) is not, and would otherwise keep a
 * build busy for hours and fill its memory.
 */
export const MAX_WALK_ENTRIES = 50_000;

export interface WalkOptions {
  /** The repository root: nothing outside it is published. */
  repoRoot: string;
  /**
   * The site folder (the one with docusystem.config.json). With it, the site's own `dist/` is also
   * refused; without it only the folders that are refused by name (`.git`, `node_modules`,
   * `.docusystem`) are.
   */
  siteDir?: string;
  /** A lower limit than MAX_WALK_ENTRIES, for tests. */
  maxEntries?: number;
}

/**
 * Every file under `dir`, relative to it, `/`-separated and sorted (by code unit, so the order is the
 * same on every machine), plus what was left out and why. A missing `dir` is an empty result (the
 * folders that are optional, `overrides/` and `public/`, need no existence check); a `dir` that is
 * not a folder, or whose real path is outside the repository, throws.
 *
 * The policy of section 4.1:
 *
 * - A symbolic link is followed only when its real path lies inside `repoRoot` and not inside
 *   `.git/`, `node_modules/` or `.docusystem/` (at any depth, relative to the repository root) or the
 *   site's `dist/`. Any other link is skipped and reported with its reason, and so is a link that does
 *   not resolve.
 * - Directory cycles are cut: a link to a folder that is being walked (one of its own ancestors, or
 *   itself) is skipped and reported. The set is the real paths of the folders on the way down, so the
 *   result does not depend on the order in which entries are read.
 * - Real folders named `.git`, `node_modules` or `.docusystem`, and the site's own `dist/`, are not
 *   entered and not reported: they are never content (this matters when the Markdown folder is the
 *   repository root).
 * - Anything that is neither a file, a folder nor a link (a socket, a device) is skipped and reported.
 * - More than MAX_WALK_ENTRIES directory entries (links are followed, so a few links can lead to
 *   millions of paths) is an error, not a very long walk.
 *
 * Names are compared without regard to case (`.GIT` is `.git` on a case-insensitive file system, and
 * `realpath` does not correct the case of what it was given).
 */
export function walkFiles(dir: string, o: WalkOptions): WalkResult {
  const top = resolve(dir);
  let topReal: string;
  try {
    topReal = realpathSync(top);
  } catch (error) {
    if (isMissing(error)) return { files: [], skipped: [] };
    throw error;
  }
  const repo = realpathSync(resolve(o.repoRoot));
  const siteDist = o.siteDir === undefined ? null : join(realpathSync(resolve(o.siteDir)), "dist");

  if (!statSync(topReal).isDirectory()) throw new Error(`${dir} is not a folder`);
  if (!isInside(repo, topReal)) {
    throw new Error(
      `${dir} is outside the repository (${topReal}): files from outside the repository are never published`,
    );
  }

  const files: string[] = [];
  const skipped: SkippedPath[] = [];
  /** The real paths of the folders on the way down to the one being read. */
  const chain = new Set<string>();
  const limit = o.maxEntries ?? MAX_WALK_ENTRIES;
  let read = 0;

  /** Why a real path may not be followed to, or null when it may. */
  const refusal = (real: string): string | null => {
    if (!isInside(repo, real)) return "a symbolic link outside the repository";
    for (const part of relative(repo, real).split(sep)) {
      const reason = NEVER_PUBLISHED.get(part.toLowerCase());
      if (reason !== undefined) return reason;
    }
    if (siteDist !== null && isInside(siteDist, real)) {
      return "a symbolic link into the site's dist folder";
    }
    return null;
  };

  const follow = (abs: string, rel: string): void => {
    let real: string;
    try {
      real = realpathSync(abs);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (isMissing(error) || code === "ELOOP") {
        skipped.push({ path: rel, reason: "a symbolic link that does not resolve" });
        return;
      }
      throw error;
    }
    const refused = refusal(real);
    if (refused !== null) {
      skipped.push({ path: rel, reason: refused });
      return;
    }
    const stat = statSync(real);
    if (stat.isFile()) {
      files.push(rel);
    } else if (stat.isDirectory()) {
      if (chain.has(real)) {
        skipped.push({
          path: rel,
          reason: "a symbolic link back to a folder that contains it (a cycle)",
        });
        return;
      }
      descend(abs, rel, real);
    } else {
      skipped.push({ path: rel, reason: "a symbolic link to something that is not a file" });
    }
  };

  const descend = (abs: string, rel: string, real: string): void => {
    chain.add(real);
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (++read > limit) {
        throw new Error(
          `${dir} has more than ${limit} files and folders once symbolic links are followed: ` +
            "a link that leads back to folders that are listed already? Refusing to walk it",
        );
      }
      const childAbs = join(abs, entry.name);
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        follow(childAbs, childRel);
      } else if (entry.isDirectory()) {
        const childReal = join(real, entry.name);
        if (NEVER_PUBLISHED.has(entry.name.toLowerCase()) || childReal === siteDist) continue;
        if (chain.has(childReal)) {
          // Reached again through a link that led out of this folder and back into it.
          skipped.push({
            path: childRel,
            reason: "a folder that a symbolic link leads back into (a cycle)",
          });
          continue;
        }
        descend(childAbs, childRel, childReal);
      } else if (entry.isFile()) {
        files.push(childRel);
      } else {
        skipped.push({ path: childRel, reason: "not a regular file or a folder" });
      }
    }
    chain.delete(real);
  };

  descend(top, "", topReal);
  files.sort();
  skipped.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, skipped };
}

/**
 * Makes sure `dir` is a real folder, creating it (and its parents) when it is absent. Throws when the
 * path is a symbolic link or a file: a folder that the CLI writes into and later deletes from
 * (`.docusystem/`, `dist/`) must be the CLI's own, never a link that a pull request committed to
 * point somewhere else.
 */
export function ensureRealDir(dir: string): void {
  const stat = lstatOrNull(dir);
  if (stat === null) {
    mkdirSync(dir, { recursive: true });
  } else if (stat.isSymbolicLink()) {
    throw new Error(`${dir} is a symbolic link: docusystem only writes into real folders`);
  } else if (!stat.isDirectory()) {
    throw new Error(`${dir} exists and is not a folder`);
  }
}

/** Writes `bytes` of `from` to `to` (the parent of `to` exists); the copy is a plain 0644 file. */
function copyBytes(from: string, to: string): void {
  copyFileSync(from, to);
  // A package installed from a read-only store (Nix) has read-only files; a copy must stay writable
  // so that the next run can replace it.
  chmodSync(to, 0o644);
}

/**
 * Copies the file `from` (a link is read through: its bytes are copied) to `to`, creating the folders
 * above it. The result is always a regular file: an existing file, read-only file or symbolic link at
 * `to` is replaced, never written through. Throws when `from` is not a file, when `to` is a folder,
 * and when both are the same file.
 */
export function copyFile(from: string, to: string): void {
  if (!statSync(from).isFile()) throw new Error(`copyFile: ${from} is not a file`);
  mkdirSync(dirname(to), { recursive: true });
  if (join(realpathSync(dirname(to)), basename(to)) === realpathSync(from)) {
    throw new Error(`copyFile: ${from} and ${to} are the same file`);
  }
  rmSync(to, { force: true });
  copyBytes(from, to);
}

/** Writes `value` as JSON to `file`: two spaces, a trailing newline, parent folders created. */
export function writeJson(file: string, value: unknown): void {
  const text = JSON.stringify(value, null, 2);
  if (text === undefined) throw new TypeError(`writeJson: the value for ${file} is not JSON`);
  mkdirSync(dirname(file), { recursive: true });
  rmSync(file, { force: true });
  writeFileSync(file, `${text}\n`);
}

/**
 * Removes `path` (a file, or a folder with everything in it) if it exists. Throws, and removes
 * nothing, unless `path` is strictly inside `parent` (not `parent` itself, not a sibling, not
 * `parent/../x`), or when a folder between `parent` and `path` is a symbolic link, because the
 * removal would then reach somewhere `parent` does not own. `path` itself may be a link: the link is
 * removed, never what it points to. `parent` itself may be a link (a site folder can be one); a
 * folder that must not be one (`.docusystem/`) is checked with `ensureRealDir`.
 */
export function removeInside(path: string, parent: string): void {
  const target = resolve(path);
  const base = resolve(parent);
  if (!isInside(base, target, { strict: true })) {
    throw new Error(`refusing to remove ${path}: it is not inside ${parent}`);
  }
  const parts = relative(base, target).split(sep);
  let at = base;
  for (const part of parts.slice(0, -1)) {
    at = join(at, part);
    const stat = lstatOrNull(at);
    if (stat === null) return; // nothing there, so nothing to remove
    if (stat.isSymbolicLink()) {
      throw new Error(`refusing to remove ${path}: ${at} is a symbolic link`);
    }
  }
  rmSync(target, { recursive: true, force: true });
}

/** Whether a process with this pid exists (EPERM means it exists and belongs to someone else). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const escapeRegExp = (text: string): string => text.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");

/** Copies the folder `from` to the new path `to`; a symbolic link or special file in it is an error. */
function copyTree(from: string, to: string): void {
  mkdirSync(to);
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) copyTree(source, target);
    else if (entry.isFile()) copyBytes(source, target);
    else if (entry.isSymbolicLink()) {
      throw new Error(`replaceDir: ${source} is a symbolic link: published files are real files`);
    } else throw new Error(`replaceDir: ${source} is not a regular file or a folder`);
  }
}

/**
 * Makes `to` a copy of the folder `from` and removes what was there, so that a reader sees the old
 * tree or the new one and never a half-written one. The copy is made next to `to`
 * (`<to>.tmp-<pid>`), the old `to` is renamed aside (`<to>.old-<pid>`), the copy is renamed into place
 * and the old tree is deleted. For the instant between the two renames `to` does not exist. If the
 * second rename fails the old tree is put back (and if that fails too, the error says where the old
 * tree is); if the copy fails (a symbolic link in `from`) `to` is untouched and the partial copy is
 * removed. `from` is not changed. `to` may not exist yet; its parent is created. Leftovers of earlier
 * runs that died (`<to>.tmp-<pid>`, `<to>.old-<pid>` of a pid that no longer runs) are removed. Needs
 * one file system for `from`'s copy and `to` (`rename`).
 */
export function replaceDir(from: string, to: string): void {
  const source = resolve(from);
  const target = resolve(to);
  if (!statSync(source).isDirectory()) throw new Error(`replaceDir: ${from} is not a folder`);
  if (isInside(source, target) || isInside(target, source)) {
    throw new Error(`replaceDir: ${from} and ${to} overlap`);
  }
  const parent = dirname(target);
  mkdirSync(parent, { recursive: true });

  const fresh = `${target}.tmp-${process.pid}`;
  const old = `${target}.old-${process.pid}`;
  const leftover = new RegExp(`^${escapeRegExp(basename(target))}\\.(?:tmp|old)-(\\d+)$`);
  for (const name of readdirSync(parent)) {
    const pid = Number.parseInt(leftover.exec(name)?.[1] ?? "", 10);
    if (Number.isInteger(pid) && (pid === process.pid || !isAlive(pid))) {
      rmSync(join(parent, name), { recursive: true, force: true });
    }
  }

  try {
    copyTree(source, fresh);
  } catch (error) {
    rmSync(fresh, { recursive: true, force: true });
    throw error;
  }
  let setAside = false;
  try {
    if (lstatOrNull(target) !== null) {
      renameSync(target, old);
      setAside = true;
    }
    renameSync(fresh, target);
  } catch (error) {
    rmSync(fresh, { recursive: true, force: true });
    if (setAside) {
      try {
        renameSync(old, target);
      } catch (restoreError) {
        // Nothing is lost: the old tree is still at `old`. Say where, and why both steps failed.
        throw new Error(
          `replaceDir: could not move the new ${to} into place (${(error as Error).message}) ` +
            `and could not put the old one back (${(restoreError as Error).message}); it is at ${old}`,
          { cause: restoreError },
        );
      }
    }
    throw error;
  }
  rmSync(old, { recursive: true, force: true });
}

/** The SHA-256 of the contents of `file`, as 64 lowercase hex digits. */
export function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}
