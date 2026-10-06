// STUB owned by WP1: the signatures are frozen (Appendix B of the architecture decision record); the
// bodies are the work package's to write and replace the throws below. WP0 never edits this file again.
import type { CatalogProject } from "./types.js";

export const CATALOG_URL = "https://avunu.net/projects.json";

/** Every way `doc` differs from the version 1 contract, as sentences; empty means it conforms. */
export function validateCatalog(_doc: unknown): string[] {
  throw new Error("not implemented (WP1)");
}

/** The catalog bundled in the package (`site/data/projects.snapshot.json`). */
export function readBundledCatalog(): CatalogProject[] {
  throw new Error("not implemented (WP1)");
}

/** The path of the bundled catalog file. */
export function bundledCatalogFile(): string {
  throw new Error("not implemented (WP1)");
}

/** Fetches the live catalog and writes it to `out` only if it conforms; never throws on network trouble. */
export async function syncCatalog(_o: {
  url?: string;
  out: string;
  timeoutMs?: number;
}): Promise<{ ok: boolean; message: string }> {
  throw new Error("not implemented (WP1)");
}

/** The catalog entry of a repository, or the entries that match it when more than one does. */
export function entryFor(
  _projects: CatalogProject[],
  _repo: string,
): { entry?: CatalogProject; ambiguous: CatalogProject[] } {
  throw new Error("not implemented (WP1)");
}
