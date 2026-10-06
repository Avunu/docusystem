// STUB owned by WP5: the signatures are frozen (Appendix B of the architecture decision record); the
// bodies are the work package's to write and replace the throws below. WP0 never edits this file again.
import type { NavData } from "./types.js";

/** The Jx output lines that are document problems. */
export const PROBLEM: RegExp = /^(?:Content\b|Warning:|Error)/;

/** The lines of Jx's output that match PROBLEM. */
export function problemsIn(_output: string): string[] {
  throw new Error("not implemented (WP5)");
}

/** N of `Done: N routes`, or null. */
export function doneRoutes(_output: string): number | null {
  throw new Error("not implemented (WP5)");
}

/** `!lenient && (strict || CI=true)` (4.1, "Strictness"). */
export function isStrict(
  _o: { lenient?: boolean; strict?: boolean },
  _env?: NodeJS.ProcessEnv,
): boolean {
  throw new Error("not implemented (WP5)");
}

/** The page count the nav promises plus the static pages of the root's `pages/`. */
export function expectedRoutes(_nav: NavData, _root: string): number {
  throw new Error("not implemented (WP5)");
}
