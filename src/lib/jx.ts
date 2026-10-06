// STUB owned by WP2: the signatures are frozen (Appendix B of the architecture decision record); the
// bodies are the work package's to write and replace the throws below. WP0 never edits this file again.
/** The Jx packages this version depends on, exact-pinned in package.json. */
export const JX_PACKAGES = [
  "@jxsuite/compiler",
  "@jxsuite/parser",
  "@jxsuite/runtime",
  "@jxsuite/search",
] as const;

/** The installed folder of one of this package's own dependencies. */
export function packageDir(_pkg: string): string {
  throw new Error("not implemented (WP2)");
}

/** `<@jxsuite/compiler>/bin/jx.js` */
export function jxCli(): string {
  throw new Error("not implemented (WP2)");
}

/** The installed versions of JX_PACKAGES. */
export function jxVersions(): Record<string, string> {
  throw new Error("not implemented (WP2)");
}

/** Links the four Jx packages into `<root>/node_modules/@jxsuite/` and returns their versions. */
export function linkJxPackages(_root: string): Record<string, string> {
  throw new Error("not implemented (WP2)");
}
