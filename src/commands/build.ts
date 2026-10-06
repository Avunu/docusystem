// `docusystem build` (section 4.1): steps 1 to 14 of the pipeline. Publishes `<site>/dist` or, when
// anything fails, leaves the previous `<site>/dist` as it was.
//
// Strict when CI=true or --strict, lenient when --lenient or DOCUSYSTEM_LENIENT=1 (lenient wins);
// main.ts has refused both flags together. Another docusystem process holding the lock is a LockError,
// which main.ts reports as exit 3.
import { runPipeline } from "../lib/pipeline.js";
import { EXIT, type CommandContext } from "./types.js";

export async function run(ctx: CommandContext): Promise<number> {
  const result = await runPipeline({
    siteArg: ctx.options.site,
    cwd: ctx.cwd,
    env: ctx.env,
    lenient: ctx.options.lenient,
    strict: ctx.options.strict,
    refreshCatalog: ctx.options.refreshCatalog,
    log: ctx.stdout,
    error: ctx.stderr,
  });
  return result.ok ? EXIT.ok : EXIT.problems;
}
