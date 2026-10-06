// STUB owned by WP3: the signatures are frozen (Appendix B of the architecture decision record); the
// bodies are the work package's to write and replace the throws below. WP0 never edits this file again.
import type { LintIssue } from "./types.js";

/** Step 6 of the pipeline (5.1): the Markdown checks over the original docs/ folder. */
export function lintDocs(_docsDir: string, _o?: { repoRoot?: string }): LintIssue[] {
  throw new Error("not implemented (WP3)");
}

/** `file:line message` */
export function formatIssue(_issue: LintIssue): string {
  throw new Error("not implemented (WP3)");
}
