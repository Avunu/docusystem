// STUB owned by WP5: the signatures are frozen (Appendix B of the architecture decision record); the
// bodies are the work package's to write and replace the throws below. WP0 never edits this file again.
import type { DocsConfig, NavData, Paths, Problem } from "./types.js";
import type { Assembly } from "./assemble.js";

export interface PipelineOptions {
  siteArg?: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  lenient?: boolean;
  strict?: boolean;
  refreshCatalog?: boolean;
  stopAfterNav?: boolean;
  ci?: boolean;
  log?: (line: string) => void;
}

export interface PipelineResult {
  ok: boolean;
  strict: boolean;
  pages: number;
  problems: Problem[];
  paths?: Paths;
  config?: DocsConfig;
  nav?: NavData;
  assembly?: Assembly;
}

/** Steps 1 to 14 of 5.1 (`build`); `check` adds 15 to 17. */
export async function runPipeline(_o: PipelineOptions): Promise<PipelineResult> {
  throw new Error("not implemented (WP5)");
}
