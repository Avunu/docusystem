// `docusystem jx <jx arguments...>` (section 4.1): a debugging aid. Assembles the project root exactly as
// a build does (steps 1 to 8: the Markdown is staged and the sidebar written, nothing is built), then
// runs the Jx this version is pinned to as `jx <arguments> <root>`, for example `docusystem jx validate`
// or `docusystem jx build --verbose`. The exit code is Jx's.
//
// Everything after the word `jx` goes to Jx unchanged (main.ts does not parse it), so `--site` has to
// come before it. The progress of the assembly goes to standard error, so that standard output is Jx's
// alone and can be piped. The lock is held while Jx runs: another docusystem process would otherwise
// rebuild the root under it. `jx dev` (it needs @jxsuite/server and Bun, and sees only the root, not the
// Markdown outside it) is not supported; `docusystem dev` is the dev server.
import { defaultDeps, runPipelineWith, spawnCommand } from "../lib/pipeline.js";
import { EXIT, type CommandContext } from "./types.js";

export async function run(ctx: CommandContext): Promise<number> {
  const [first] = ctx.args;
  if (first === undefined) {
    ctx.stderr(
      "docusystem: jx needs the Jx command to run, for example `docusystem jx validate`. " +
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
