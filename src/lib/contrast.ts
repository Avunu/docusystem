// STUB owned by WP4: the signatures are frozen (Appendix B of the architecture decision record); the
// bodies are the work package's to write and replace the throws below. WP0 never edits this file again.
import type { Failure, Highlight } from "./types.js";

/** Step 15 of the pipeline (5.1): the WCAG pairs over the resolved tokens. */
export function contrastFailures(
  _style: Record<string, unknown>,
  _highlight: Highlight | null,
): { checked: number; failures: Failure[] } {
  throw new Error("not implemented (WP4)");
}

/** The search highlight (`color-mix(...)`) of a component style rule, or null. */
export function highlightOf(_rule: Record<string, unknown> | undefined): Highlight | null {
  throw new Error("not implemented (WP4)");
}
