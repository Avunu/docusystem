// STUB owned by WP6: `run` is frozen (section 11 of the architecture decision record); the body is the work
// package's to write and replaces the throw below. WP0 never edits this file again.
import type { DocsConfig } from "../lib/types.js";
import type { CommandContext } from "./types.js";

/** What `decide` needs to settle the seven identity keys (4.1.2); WP6 may add fields. */
export interface InitOptions {
  /** The folder the shell is written into (absolute). */
  siteDir: string;
  /** The repository root (absolute). */
  repoRoot: string;
  name?: string;
  tagline?: string;
  slug?: string;
  platform?: string;
  repo?: string;
  domain?: string;
  license?: string;
  branch?: string;
  docs?: string;
}

/** Infers the identity keys from `origin`, the catalog and the existing config; throws naming the missing option. */
export function decide(_o: InitOptions): { config: DocsConfig; notes: string[] } {
  throw new Error("not implemented (WP6)");
}

export async function run(_ctx: CommandContext): Promise<number> {
  throw new Error("not implemented (WP6)");
}
