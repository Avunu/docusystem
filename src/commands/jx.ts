// `docusystem jx <jx arguments...>` (section 4.1): a debugging aid. Assembles the project root exactly as
// a build does (steps 1 to 8: the Markdown is staged and the sidebar written; docusystem itself builds
// nothing), then runs the Jx this version is pinned to as `jx <arguments> <root>`, for example
// `docusystem jx build --verbose`. The exit code is Jx's.
//
// Everything after the word `jx` goes to Jx unchanged (main.ts does not parse it), so `--site` has to
// come before it. The progress of the assembly goes to standard error, so that standard output is Jx's
// alone and can be piped. The lock is held while Jx runs: another docusystem process would otherwise
// rebuild the root under it. `jx dev` (it needs @jxsuite/server and Bun, and sees only the root, not the
// Markdown outside it) is not supported; `docusystem dev` is the dev server.
//
// `jx validate` cannot succeed on this root, for two reasons. The root is assembled from empty on every
// run, so the project.schema.json that `jx schema` wrote is gone before `jx validate` looks for it
// (keeping the previous root would only swap this failure for the next). And with the schema in place,
// Jx's schema for a Function entry has no `timing` key although its compiler accepts one, so the
// package's own pages are reported as invalid. The command says so, instead of leaving a user to follow
// Jx's "run `jx schema`" advice in a circle. The integration canary (test/integration/canary.test.ts)
// fails when a Jx release changes either fact.
import { defaultDeps, runPipelineWith, spawnCommand } from "../lib/pipeline.js";
import { EXIT, type CommandContext } from "./types.js";

/** Printed (to standard error) before `jx validate` runs: see the comment at the top of this file. */
const VALIDATE_NOTE = [
  "docusystem: note: `jx validate` does not work on the generated root. The root is assembled afresh on every",
  "run, so the project.schema.json that `jx schema` writes is gone before validate looks for it; with the",
  "schema in place Jx reports the package's own pages as invalid (its schema has no `timing` key for a",
  "Function entry, which its compiler accepts). `docusystem jx build --verbose` is the command that works.",
];

export async function run(ctx: CommandContext): Promise<number> {
  const [first] = ctx.args;
  if (first === undefined) {
    ctx.stderr(
      "docusystem: jx needs the Jx command to run, for example `docusystem jx build --verbose`. " +
        "(Everything after jx is passed to Jx; give --site before it.)",
    );
    return EXIT.usage;
  }
  if (first === "dev") {
    ctx.stderr(
      "docusystem: `jx dev` is not supported: it needs @jxsuite/server and Bun and does not see the " +
        "Markdown outside the project root. Use `docusystem dev`.",
    );
    return EXIT.usage;
  }

  const deps = defaultDeps();
  let jxExit: number = EXIT.problems;
  const result = await runPipelineWith(
    {
      siteArg: ctx.options.site,
      cwd: ctx.cwd,
      env: ctx.env,
      stopAfterNav: true,
      log: ctx.stderr,
      error: ctx.stderr,
    },
    deps,
    {
      whileLocked: async (assembled) => {
        const root = assembled.paths?.root;
        if (root === undefined) return;
        if (first === "validate") for (const line of VALIDATE_NOTE) ctx.stderr(line);
        const finished = await spawnCommand([process.execPath, deps.jxCli(), ...ctx.args, root], {
          cwd: root,
          env: ctx.env,
          onLine: (line, stream) => (stream === "stdout" ? ctx.stdout(line) : ctx.stderr(line)),
        });
        jxExit = finished.code;
      },
    },
  );
  return result.ok ? jxExit : EXIT.problems;
}
