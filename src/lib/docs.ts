// STUB owned by WP3: the signatures are frozen (Appendix B of the architecture decision record); the
// bodies are the work package's to write and replace the throws below. WP0 never edits this file again.
import type { DocFile } from "./types.js";

/** Every documentation file under `root` (the staged copy), parsed. */
export function readDocs(_root: string): DocFile[] {
  throw new Error("not implemented (WP3)");
}

/** Whether a path is left out of the collection (the `exclude` rule of the docs content type). */
export function isExcluded(_rel: string): boolean {
  throw new Error("not implemented (WP3)");
}

/** The `where` clause of the docs content type: `draft: true` and `publish: false` keep a page out. */
export function isPublished(_data: Record<string, unknown>): boolean {
  throw new Error("not implemented (WP3)");
}

/** The URL a documentation file is published at (the `route` rule of the docs content type). */
export function urlFor(_file: Pick<DocFile, "dir" | "base" | "isIndex">): string {
  throw new Error("not implemented (WP3)");
}
