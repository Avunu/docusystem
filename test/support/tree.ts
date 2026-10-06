import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

/**
 * One entry of a tree to write: a file with these contents, a symbolic link (the target is written as
 * given, so a relative one is relative to the link's folder), or an empty folder.
 */
export type TreeEntry = string | Uint8Array | { symlink: string } | { dir: true };

/** `/`-separated paths below the root, and what is at each. */
export type TreeSpec = Record<string, TreeEntry>;

/** Writes `spec` under `root` (created if needed); folders in between are created. Returns `root`. */
export function writeTree(root: string, spec: TreeSpec): string {
  mkdirSync(root, { recursive: true });
  for (const [path, entry] of Object.entries(spec)) {
    const target = join(root, ...path.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    if (typeof entry === "string" || entry instanceof Uint8Array) writeFileSync(target, entry);
    else if ("symlink" in entry) symlinkSync(entry.symlink, target);
    else mkdirSync(target, { recursive: true });
  }
  return root;
}

/**
 * Everything under `root`, sorted: files as `path`, folders as `path/`, symbolic links as
 * `path -> target` (never followed). For asserting that a run left a tree as it was.
 */
export function listTree(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const rel = `${prefix}${name}`;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) out.push(`${rel} -> ${readlinkSync(path)}`);
      else if (stat.isDirectory()) {
        out.push(`${rel}/`);
        visit(path, `${rel}/`);
      } else out.push(rel);
    }
  };
  visit(root, "");
  return out.sort();
}

/** The contents of every regular file under `root`, by `/`-separated relative path (links are skipped). */
export function readTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const visit = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) visit(path, `${prefix}${name}/`);
      else if (stat.isFile()) out[`${prefix}${name}`] = readFileSync(path, "utf8");
    }
  };
  visit(root, "");
  return out;
}
