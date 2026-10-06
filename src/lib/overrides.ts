// STUB owned by WP2: the signatures are frozen (Appendix B of the architecture decision record); the
// bodies are the work package's to write and replace the throws below. WP0 never edits this file again.
import type { Finding } from "./types.js";

/** `docusystem eject`: copies a package file into `<site>/overrides/` and records it in `.ejected.json`. */
export function ejectFile(
  _siteDir: string,
  _rel: string,
  _o?: { force?: boolean },
): { to: string } {
  throw new Error("not implemented (WP2)");
}

/** Drift of the overrides against the package: `current`, `changed`, `stale` and `not ejected`. */
export function overrideFindings(_siteDir: string): Finding[] {
  throw new Error("not implemented (WP2)");
}
