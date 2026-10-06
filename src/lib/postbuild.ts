// STUB owned by WP4: the signatures are frozen (Appendix B of the architecture decision record); the
// bodies are the work package's to write and replace the throws below. WP0 never edits this file again.
import type { DocsConfig, NavData, PostbuildSummary } from "./types.js";

/** Step 11 of the pipeline (5.1): fixes the Jx output in place. */
export function runPostbuild(
  _dist: string,
  _config: DocsConfig & { branch: string },
  _nav: NavData,
  _o: { repoRoot: string; docsDir: string },
): PostbuildSummary {
  throw new Error("not implemented (WP4)");
}
