// STUB owned by WP3: the signatures are frozen (Appendix B of the architecture decision record); the
// bodies are the work package's to write and replace the throws below. WP0 never edits this file again.
import type { DocFile, DocsConfig, NavData, Paths } from "./types.js";

/** The sidebar, previous/next and landing cards, from the documentation files. */
export function buildNav(_files: DocFile[], _name: string): { nav: NavData; warnings: string[] } {
  throw new Error("not implemented (WP3)");
}

/** Step 7 of the pipeline (5.1): writes `paths.navFile` and returns the page count. */
export function writeNav(
  _paths: Paths,
  _config: DocsConfig,
): { nav: NavData; warnings: string[]; pages: number } {
  throw new Error("not implemented (WP3)");
}
