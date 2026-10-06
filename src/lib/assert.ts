// STUB owned by WP4: the signatures are frozen (Appendix B of the architecture decision record); the
// bodies are the work package's to write and replace the throws below. WP0 never edits this file again.
import type { Assertion } from "./types.js";

/** Step 12 of the pipeline (5.1): positive assertions on the built site. */
export function assertBuild(
  _root: string,
  _dist: string,
  _expected: { cname: string; routes: number | null },
): Assertion[] {
  throw new Error("not implemented (WP4)");
}
