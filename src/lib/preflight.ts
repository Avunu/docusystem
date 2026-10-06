// STUB owned by WP1: the signatures are frozen (Appendix B of the architecture decision record); the
// bodies are the work package's to write and replace the throws below. WP0 never edits this file again.
import type { DocsConfig, Paths } from "./types.js";

/** What the catalog says about a slug: an error for a differently spelled key, a warning for an unknown one. */
export function checkSlug(_slug: string, _slugs?: string[]): { error?: string; warning?: string } {
  throw new Error("not implemented (WP1)");
}

/** Steps 1 and 2 of the pipeline (5.1): config, paths, docs home, slug, leftovers. */
export function preflight(_siteDir: string): {
  config?: DocsConfig;
  paths?: Paths;
  errors: string[];
  warnings: string[];
} {
  throw new Error("not implemented (WP1)");
}
