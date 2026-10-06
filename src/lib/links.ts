// STUB owned by WP4: the signatures are frozen (Appendix B of the architecture decision record); the
// bodies are the work package's to write and replace the throws below. WP0 never edits this file again.
import type { LinkIssue, LinkReport, NavData } from "./types.js";

/** Step 16 of the pipeline (5.1): crawls a built site; every link, anchor and asset must resolve. */
export function checkLinks(_dist: string, _o?: { nav?: NavData }): LinkReport {
  throw new Error("not implemented (WP4)");
}

/** The issues of a crawl, one per line. */
export function formatIssues(_issues: LinkIssue[]): string {
  throw new Error("not implemented (WP4)");
}
