// STUB owned by WP1: the signatures are frozen (Appendix B of the architecture decision record); the
// bodies are the work package's to write and replace the throws below. WP0 never edits this file again.
import type { DocsConfig, Paths } from "./types.js";

export const CONFIG_FILE = "docusystem.config.json";

/** A configuration that is not valid: `problems` holds every one of them, as sentences. */
export class ConfigError extends Error {
  problems: string[];

  constructor(problems: string[]) {
    super(problems.join("\n"));
    this.name = "ConfigError";
    this.problems = problems;
  }
}

/** Every way `raw` is not a valid docusystem.config.json, as sentences; empty means valid. */
export function validateConfig(_raw: unknown): string[] {
  throw new Error("not implemented (WP1)");
}

/** Reads and validates `<siteDir>/docusystem.config.json`; throws ConfigError. */
export function readConfig(_siteDir: string): DocsConfig {
  throw new Error("not implemented (WP1)");
}

/** The site folder (4.1): `--site`, else the current folder, else `./docs-site`. */
export function findSiteDir(_arg: string | undefined, _cwd: string): string {
  throw new Error("not implemented (WP1)");
}

/** The nearest ancestor of the site folder that contains `.git`, else the site folder's parent. */
export function findRepoRoot(_siteDir: string): string {
  throw new Error("not implemented (WP1)");
}

/** config `branch`, else $DOCUSYSTEM_BRANCH, else origin/HEAD, else `main`. */
export function resolveBranch(
  _config: Pick<DocsConfig, "branch">,
  _repoRoot: string,
  _env?: NodeJS.ProcessEnv,
): string {
  throw new Error("not implemented (WP1)");
}

/** Every path of a run (3.2); the docs folder must lie inside the repository. */
export function pathsFor(_siteDir: string, _config: Pick<DocsConfig, "docs">): Paths {
  throw new Error("not implemented (WP1)");
}
