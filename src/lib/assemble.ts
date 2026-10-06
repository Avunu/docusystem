// STUB owned by WP2: the signatures are frozen (Appendix B of the architecture decision record); the
// bodies are the work package's to write and replace the throws below. WP0 never edits this file again.
import type { DocsConfig, Manifest, Paths, SkippedPath } from "./types.js";

export interface AssembleArgs {
  paths: Paths;
  config: DocsConfig;
  branch: string;
  strict: boolean;
  refreshCatalog?: boolean;
  catalogUrl?: string;
  env?: NodeJS.ProcessEnv;
}

export interface Assembly {
  manifest: Manifest;
  shadowed: string[];
  added: string[];
  skipped: SkippedPath[];
  warnings: string[];
  errors: string[];
}

/** Steps 3 to 4 of the pipeline (5.1): the generated Jx project root. */
export async function assemble(_args: AssembleArgs): Promise<Assembly> {
  throw new Error("not implemented (WP2)");
}
