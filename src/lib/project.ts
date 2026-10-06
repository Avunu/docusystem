// STUB owned by WP2: the signatures are frozen (Appendix B of the architecture decision record); the
// bodies are the work package's to write and replace the throws below. WP0 never edits this file again.
import type { DocsConfig } from "./types.js";

/** The package's `site/project.base.json`. */
export function readBaseProject(): Record<string, unknown> {
  throw new Error("not implemented (WP2)");
}

/** The design-token names the base project knows: `light` (`--*` style keys) and `dark` (`@--dark`). */
export function knownTokens(_base: Record<string, unknown>): {
  light: Set<string>;
  dark: Set<string>;
} {
  throw new Error("not implemented (WP2)");
}

/** The `jx` escape hatch (4.2): objects merge, `null` deletes, `$head` appends, other arrays replace. */
export function mergeJx(
  _project: Record<string, unknown>,
  _fragment: Record<string, unknown>,
  _warnings: string[],
): Record<string, unknown> {
  throw new Error("not implemented (WP2)");
}

/** The generated `project.json` (4.2): base + identity + `links` by strictness + theme + images + `jx`. */
export function generateProject(
  _config: DocsConfig,
  _o: { strict: boolean; base?: Record<string, unknown> },
): { project: Record<string, unknown>; errors: string[]; warnings: string[] } {
  throw new Error("not implemented (WP2)");
}
