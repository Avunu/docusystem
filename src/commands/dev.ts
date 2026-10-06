// `docusystem dev` (section 5.2): build once, serve what would be deployed on 127.0.0.1, rebuild on every
// change and reload the browser. Always lenient: the point is to see the page while the Markdown is
// still being fixed (CI=true does not make it strict).
//
// The first build must succeed (exit 1 otherwise, and 1 when the port is taken). After that a failed
// rebuild prints its problems and the last good build keeps being served. Ctrl-C (SIGINT), SIGTERM and
// SIGHUP, or the context's abort signal, stop it cleanly with exit 0.
import { LockError } from "../lib/lock.js";
import { startDev, type RebuildStatus } from "../lib/devserver.js";
import { runPipeline, type PipelineResult } from "../lib/pipeline.js";
import { EXIT, type CommandContext } from "./types.js";

export async function run(ctx: CommandContext): Promise<number> {
  const build = (): Promise<PipelineResult> =>
    runPipeline({
      siteArg: ctx.options.site,
      cwd: ctx.cwd,
      env: ctx.env,
      lenient: true,
      log: ctx.stdout,
      error: ctx.stderr,
    });

  const started = Date.now();
  const first = await build();
  if (!first.ok || first.paths === undefined) {
    ctx.stderr("dev: the first build failed: fix the problems above and run docusystem dev again");
    return EXIT.problems;
  }
  ctx.stdout(`dev: built in ${Date.now() - started} ms`);
  const { paths } = first;

  const rebuild = async (): Promise<RebuildStatus> => {
    const at = Date.now();
    try {
      const result = await build();
      ctx.stdout(
        result.ok
          ? `dev: rebuilt in ${Date.now() - at} ms`
          : `dev: the build failed (${Date.now() - at} ms): still serving the last good build`,
      );
      return result.ok ? "ok" : "failed";
    } catch (error) {
      if (error instanceof LockError) {
        ctx.stderr(`dev: ${error.message}; trying again in a moment`);
        return "busy";
      }
      throw error;
    }
  };

  const port = ctx.options.port ?? 3000;
  let handle;
  try {
    handle = await startDev({
      paths,
      port,
      rebuild,
      log: ctx.stdout,
      error: ctx.stderr,
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EADDRINUSE" || code === "EACCES") {
      ctx.stderr(
        `dev: cannot listen on 127.0.0.1:${port} (${code === "EADDRINUSE" ? "already in use" : "not allowed"}): ` +
          "stop what is using it, or pass --port <n>",
      );
      return EXIT.problems;
    }
    throw error;
  }
  ctx.stdout(
    `dev: ${handle.url}  (watching ${paths.docsDir}, overrides/, public/ and docusystem.config.json; Ctrl-C stops)`,
  );

  return new Promise<number>((done) => {
    const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
    const stop = (): void => {
      for (const signal of signals) process.off(signal, stop);
      ctx.signal.removeEventListener("abort", stop);
      void handle.close().then(() => done(EXIT.ok));
    };
    for (const signal of signals) process.once(signal, stop);
    if (ctx.signal.aborted) stop();
    else ctx.signal.addEventListener("abort", stop, { once: true });
  });
}
