// `docusystem build` and `docusystem check` from a shell to `<site>/dist` (section 5.1 of the
// architecture decision record). This module only orders the steps and decides what is a failure; each
// step is done by the module that owns it:
//
//   1 preflight   config.ts, preflight.ts      7 nav        docs.ts, nav.ts
//   2 (same)                                   9 jx         here (a child process of the pinned Jx)
//   3 lock        lock.ts                      10 classify  strict.ts
//   4 assemble    assemble.ts                  11 postbuild postbuild.ts
//   5 stage       stage.ts                     12 assert    assert.ts
//   6 lint        lint.ts                      13 publish   fsutil.ts
//
// Steps 15 to 17 (contrast, the link crawl, the CI summary) are `check`'s and live in commands/check.ts.
//
// Problems are collected, not thrown, until step 10; what a problem is and how strictness changes it is
// in strict.ts. Everything the pipeline prints has one prefix per stage (`stage:`, `lint:`, ...), and
// with `ci` each error, and each warning that has a location, is also printed as a GitHub Actions
// annotation (ci.ts). Nothing is published unless the build passed: a failed build leaves the previous
// `<site>/dist` exactly as it was.
//
// The neighbours are reached through `PipelineDeps` so that the order and the decisions can be tested
// without them (test/commands/pipeline.test.ts) and against the real pinned Jx with documented fakes
// for them (test/integration/jx-canary.test.ts); `runPipeline` is `runPipelineWith` with the real ones.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { assemble, type AssembleArgs, type Assembly } from "./assemble.js";
import { assertBuild } from "./assert.js";
import { annotation } from "./ci.js";
import { ConfigError, findSiteDir, resolveBranch } from "./config.js";
import { replaceDir } from "./fsutil.js";
import { jxCli } from "./jx.js";
import { formatIssue, lintDocs } from "./lint.js";
import { acquireLock } from "./lock.js";
import { writeNav } from "./nav.js";
import { hasJxFragment, JX_FRAGMENT } from "./overrides.js";
import { runPostbuild } from "./postbuild.js";
import { preflight } from "./preflight.js";
import { stageSite } from "./stage.js";
import {
  doneRoutes,
  expectedRoutes,
  failureProblems,
  imageHint,
  isStrict,
  lenientNotice,
  problemsIn,
  shellCommand,
  strictFailure,
} from "./strict.js";
import type {
  Assertion,
  DocsConfig,
  LintIssue,
  NavData,
  Paths,
  PostbuildSummary,
  Problem,
  StageResult,
} from "./types.js";

export interface PipelineOptions {
  /** `--site <dir>`. */
  siteArg?: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  lenient?: boolean;
  strict?: boolean;
  refreshCatalog?: boolean;
  /** Stop after step 7, with the root assembled and the lock released (`docusystem jx`, `info --nav`). */
  stopAfterNav?: boolean;
  /** Print a GitHub Actions annotation for every error and every located warning. */
  ci?: boolean;
  /** Where lines of progress go (standard output). Default: standard output. */
  log?: (line: string) => void;
  /** Where warnings, errors and the final verdict go (standard error). Default: `log`. */
  error?: (line: string) => void;
}

export interface PipelineResult {
  ok: boolean;
  strict: boolean;
  /** The pages written to `<site>/dist` (what post-processing counted); 0 when nothing was published. */
  pages: number;
  /** Every error and warning of the run, in the order they were found. */
  problems: Problem[];
  paths?: Paths;
  config?: DocsConfig;
  nav?: NavData;
  assembly?: Assembly;
}

/** What a run of the Jx command line left: its exit code and everything it printed, in order. */
export interface JxRun {
  code: number;
  output: string;
}

/** The modules of the other work packages (and the child process) that the pipeline calls. */
export interface PipelineDeps {
  findSiteDir: typeof findSiteDir;
  preflight: typeof preflight;
  resolveBranch: typeof resolveBranch;
  acquireLock: typeof acquireLock;
  assemble: typeof assemble;
  stageSite: typeof stageSite;
  lintDocs: typeof lintDocs;
  formatIssue: typeof formatIssue;
  writeNav: typeof writeNav;
  jxCli: typeof jxCli;
  /** Runs `command` (`[node, jx.js, "build", root]`) in `cwd`; `onLine` gets every line as it is printed. */
  runJx: (command: string[], o: SpawnOptions) => Promise<JxRun>;
  runPostbuild: typeof runPostbuild;
  assertBuild: typeof assertBuild;
  replaceDir: typeof replaceDir;
}

export interface SpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Gets each line as it is printed, with the stream it came on. */
  onLine?: (line: string, stream: "stdout" | "stderr") => void;
}

/**
 * Runs a command and collects what it prints. Standard output and standard error are merged in the
 * order the chunks arrive, so the log reads as the terminal would have; standard input is closed, so a
 * prompt cannot hang a build. Rejects only when the process cannot be started.
 */
export function spawnCommand(command: string[], o: SpawnOptions): Promise<JxRun> {
  return new Promise((resolve, reject) => {
    const [program, ...args] = command;
    if (program === undefined) {
      reject(new Error("no command to run"));
      return;
    }
    const child = spawn(program, args, {
      cwd: o.cwd,
      env: o.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: string[] = [];
    const partial = { stdout: "", stderr: "" };
    const feed = (stream: "stdout" | "stderr", data: string): void => {
      chunks.push(data);
      if (o.onLine === undefined) return;
      partial[stream] += data;
      for (let end = partial[stream].indexOf("\n"); end >= 0; end = partial[stream].indexOf("\n")) {
        o.onLine(partial[stream].slice(0, end).replace(/\r$/, ""), stream);
        partial[stream] = partial[stream].slice(end + 1);
      }
    };
    child.stdout.setEncoding("utf8").on("data", (data: string) => feed("stdout", data));
    child.stderr.setEncoding("utf8").on("data", (data: string) => feed("stderr", data));
    child.once("error", reject);
    child.once("close", (code) => {
      for (const stream of ["stdout", "stderr"] as const) {
        if (partial[stream] !== "") o.onLine?.(partial[stream], stream);
      }
      resolve({ code: code ?? 1, output: chunks.join("") });
    });
  });
}

/** The real modules. */
export function defaultDeps(): PipelineDeps {
  return {
    findSiteDir,
    preflight,
    resolveBranch,
    acquireLock,
    assemble,
    stageSite,
    lintDocs,
    formatIssue,
    writeNav,
    jxCli,
    runJx: spawnCommand,
    runPostbuild,
    assertBuild,
    replaceDir,
  };
}

/** Extra points where a caller can join the run. */
export interface PipelineHooks {
  /**
   * With `stopAfterNav`: called once the root is assembled, while the lock is still held, and the lock
   * is released when it settles. `docusystem jx` runs the Jx the user asked for here, so that no other
   * docusystem process rebuilds the root under it.
   */
  whileLocked?: (result: PipelineResult) => Promise<void>;
}

/** The stage prefixes of the output (section 4.1), at the start of a line that was written with one. */
const PREFIXED =
  /^(preflight|assemble|stage|lint|nav|jx|postbuild|assert|contrast|links|overrides|catalog): ?/;

/** The error classes that mean a bug in this package, not a problem with the project (main.ts agrees). */
const isInternal = (error: unknown): boolean =>
  error instanceof TypeError ||
  error instanceof RangeError ||
  error instanceof ReferenceError ||
  error instanceof SyntaxError;

/** Steps 1 to 14 of 5.1 (`build`); `check` adds 15 to 17. */
export async function runPipeline(o: PipelineOptions): Promise<PipelineResult> {
  return runPipelineWith(o, defaultDeps());
}

/** `runPipeline` with the neighbours given: the order of the steps and every decision are here. */
export async function runPipelineWith(
  o: PipelineOptions,
  deps: PipelineDeps,
  hooks: PipelineHooks = {},
): Promise<PipelineResult> {
  const log = o.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const error = o.error ?? log;
  const strict = isStrict(o, o.env);
  const problems: Problem[] = [];
  /** How many problems are document problems: the ones strictness decides about. */
  let documentProblems = 0;
  let repoRoot = "";

  const repoRelative = (absolute: string): string =>
    relative(repoRoot, absolute).split(sep).join("/");

  /** Records a problem, and annotates it when the run asks for annotations (errors, and located warnings). */
  const record = (
    level: "error" | "warning",
    stage: string,
    message: string,
    where: { file?: string; line?: number } = {},
  ): void => {
    problems.push({
      level,
      message,
      ...(where.file === undefined ? {} : { file: where.file }),
      ...(where.line === undefined ? {} : { line: where.line }),
    });
    if (o.ci === true && (level === "error" || where.file !== undefined)) {
      log(annotation(level, message, where.file, where.line, stage));
    }
  };
  const warn = (stage: string, message: string, where?: { file?: string; line?: number }): void => {
    error(`${stage}: warning: ${message}`);
    record("warning", stage, message, where);
  };
  const fail = (stage: string, message: string, where?: { file?: string; line?: number }): void => {
    error(`${stage}: error: ${message}`);
    record("error", stage, message, where);
  };
  /** A document problem: an error in a strict build, a warning in a lenient one (already printed by the caller). */
  const documentProblem = (
    stage: string,
    message: string,
    where?: { file?: string; line?: number },
  ): void => {
    documentProblems++;
    record(strict ? "error" : "warning", stage, message, where);
  };

  const result = (ok: boolean, rest: Partial<PipelineResult> = {}): PipelineResult => ({
    ok,
    strict,
    pages: 0,
    problems,
    ...rest,
  });

  // ---- steps 1 and 2: preflight ----
  let siteDir: string;
  try {
    siteDir = deps.findSiteDir(o.siteArg, o.cwd);
  } catch (caught) {
    if (isInternal(caught)) throw caught;
    fail("preflight", (caught as Error).message);
    return result(false);
  }
  let report: ReturnType<typeof deps.preflight>;
  try {
    report = deps.preflight(siteDir);
  } catch (caught) {
    if (!(caught instanceof ConfigError)) throw caught;
    for (const problem of caught.problems) fail("preflight", problem);
    return result(false);
  }
  for (const warning of report.warnings) warn("preflight", warning);
  const { config, paths } = report;
  if (report.errors.length > 0 || config === undefined || paths === undefined) {
    for (const message of report.errors) fail("preflight", message);
    return result(false);
  }
  repoRoot = paths.repoRoot;
  const branch = deps.resolveBranch(config, paths.repoRoot, o.env);
  log(
    `preflight: site ${paths.siteDir}, Markdown ${paths.docsDir}, branch ${branch}, ` +
      (strict
        ? "strict (document problems fail the build)"
        : "lenient (document problems are warnings)"),
  );
  const docsLabel = repoRelative(paths.docsDir);
  const docsFile = (rel: string): string => (docsLabel === "" ? rel : `${docsLabel}/${rel}`);

  // ---- step 3: the lock ----
  // A LockError (another docusystem process holds it) is not caught: main.ts turns it into exit 3.
  const release = deps.acquireLock(paths);
  try {
    // ---- step 4: assemble ----
    const args: AssembleArgs = { paths, config, branch, strict, env: o.env };
    if (o.refreshCatalog === true) args.refreshCatalog = true;
    const catalogUrl = o.env.DOCUSYSTEM_CATALOG_URL;
    if (catalogUrl !== undefined && catalogUrl !== "") args.catalogUrl = catalogUrl;
    const assembly = await deps.assemble(args);
    const { manifest } = assembly;
    log(
      `assemble: ${Object.keys(manifest.files).length} file(s) in ${paths.root} ` +
        `(docusystem ${manifest.docusystem}, @jxsuite/compiler ${manifest.jx["@jxsuite/compiler"] ?? "?"})`,
    );
    for (const file of assembly.shadowed) {
      log(`overrides: ${file} replaces the package's file (it does not follow package updates)`);
    }
    for (const file of assembly.added) log(`overrides: ${file} is added to the package's files`);
    log(`catalog: ${manifest.catalog === "live" ? "live copy" : "bundled snapshot"}`);
    // WP2 hands over complete lines that carry their own stage prefix (`overrides: ...`, `catalog: ...`,
    // `assemble: ...`): they are printed as they are, and recorded without the prefix.
    const stageOf = (line: string): { stage: string; text: string; shown: string } => {
      const found = PREFIXED.exec(line);
      return found === null
        ? { stage: "assemble", text: line, shown: `assemble: ${line}` }
        : { stage: found[1]!, text: line.slice(found[0].length), shown: line };
    };
    for (const line of assembly.warnings) {
      const { stage, text, shown } = stageOf(line);
      error(shown);
      record("warning", stage, text);
    }
    for (const skipped of assembly.skipped) {
      // relative to the site folder (`public/logo.svg`); the reader and GitHub know it from the repository root
      const file = repoRelative(join(paths.siteDir, skipped.path));
      const message = `${file} is ${skipped.reason}: not published`;
      error(`assemble: ${message}`);
      documentProblem("assemble", message, { file });
    }
    for (const line of assembly.errors) {
      const { stage, text, shown } = stageOf(line);
      error(shown);
      record("error", stage, text);
    }
    if (assembly.errors.length > 0) {
      error(
        `docusystem: the project could not be assembled (${assembly.errors.length} error(s) above): nothing was built`,
      );
      return result(false, { paths, config, assembly });
    }

    // ---- step 5: stage ----
    const staged: StageResult = deps.stageSite(paths, config, branch);
    for (const link of staged.links) {
      log(`stage: ${docsFile(link.file)}:${link.line}  ${link.from} -> ${link.to}`);
    }
    for (const file of staged.comments) {
      log(`stage: ${docsFile(file)}  moved the comment above the front matter below it`);
    }
    for (const skipped of staged.skipped) {
      const message = `${docsFile(skipped.path)} is ${skipped.reason}: not published`;
      error(`stage: ${message}`);
      documentProblem("stage", message, { file: docsFile(skipped.path) });
    }
    log(
      `stage: ${staged.files} file(s), ${staged.links.length} link(s) to repository files rewritten`,
    );

    // ---- step 6: lint ----
    const issues: LintIssue[] = deps.lintDocs(paths.docsDir, { repoRoot: paths.repoRoot });
    for (const issue of issues) {
      const isError = issue.level === "error";
      const level = isError && strict ? "error" : "warning";
      error(`lint: ${level}: ${deps.formatIssue(issue)}`);
      if (isError) documentProblems++;
      record(level, "lint", issue.message, { file: docsFile(issue.file), line: issue.line });
    }

    // ---- step 7: nav ----
    const written = deps.writeNav(paths, config);
    const { nav } = written;
    for (const warning of written.warnings) warn("nav", warning);
    log(`nav: ${written.pages} page(s)`);
    const assembled = { paths, config, nav, assembly };

    // ---- step 8: `docusystem jx` stops here ----
    if (o.stopAfterNav === true) {
      const stopped = result(true, assembled);
      await hooks.whileLocked?.(stopped);
      return stopped;
    }

    // ---- step 9: jx ----
    const command = [process.execPath, deps.jxCli(), "build", paths.root];
    log(`jx: ${shellCommand(command)}`);
    const jx = await deps.runJx(command, {
      cwd: paths.root,
      env: o.env,
      onLine: (line) => log(line),
    });
    mkdirSync(dirname(paths.jxLog), { recursive: true });
    writeFileSync(paths.jxLog, jx.output);
    // Jx's own words are echoed already: each of these is recorded (and annotated), not printed again.
    for (const line of problemsIn(jx.output)) documentProblem("jx", line);
    if (jx.code !== 0) {
      for (const line of failureProblems(jx.output)) documentProblem("jx", line);
      error(
        `docusystem: jx build failed. The assembled project is ${paths.root}; run: ${shellCommand(command)}`,
      );
      const hint = imageHint(jx.output);
      if (hint !== null) error(`docusystem: ${hint}`);
      record("error", "jx", `jx build failed (exit code ${jx.code}); see ${paths.jxLog}`);
      if (strict && documentProblems > 0) error(strictFailure(documentProblems));
      return result(false, assembled);
    }

    // ---- step 10: classify ----
    const expected = expectedRoutes(nav, paths.root);
    const routes = doneRoutes(jx.output);
    if (routes === null) {
      const message =
        'Jx printed no "Done: N routes" line, so the number of routes could not be checked';
      error(`jx: ${strict ? "error" : "warning"}: ${message}`);
      documentProblem("jx", message);
    } else if (routes < expected) {
      const message =
        `Jx dropped routes: it built ${routes}, the documents and the site's own pages promise ${expected}. ` +
        "Two pages with one address, or a page Jx could not route, are the usual cause.";
      error(`jx: ${strict ? "error" : "warning"}: ${message}`);
      documentProblem("jx", message);
    }
    if (documentProblems > 0) {
      if (strict) {
        error(strictFailure(documentProblems));
        return result(false, assembled);
      }
      error(lenientNotice(documentProblems));
    }

    // ---- step 11: postbuild ----
    const summary: PostbuildSummary = deps.runPostbuild(paths.jxDist, { ...config, branch }, nav, {
      repoRoot: paths.repoRoot,
      docsDir: paths.docsDir,
    });
    for (const link of summary.repoLinks) {
      log(`postbuild: ${link.page}  ${link.from} -> ${link.to}`);
    }
    for (const warning of summary.warnings) warn("postbuild", warning);
    log(
      `postbuild: ${summary.pages} page(s), ${summary.sitemapUrls} in the sitemap, ` +
        `${summary.canonicals} canonical URL(s) set, ${summary.searchTitles} search title(s) fixed, ` +
        `CNAME ${summary.cname ? "present" : "absent"}`,
    );

    // ---- step 12: assert (fatal in every mode) ----
    const assertions: Assertion[] = deps.assertBuild(paths.root, paths.jxDist, {
      cname: config.domain,
      routes: expected,
    });
    let failed = 0;
    for (const assertion of assertions) {
      if (assertion.ok) {
        log(`assert: ok: ${assertion.message}`);
      } else {
        failed++;
        error(`assert: FAIL: ${assertion.message}`);
        record("error", "assert", assertion.message);
      }
    }
    if (failed > 0) {
      error(`docusystem: ${failed} output assertion(s) failed. Nothing was published.`);
      return result(false, assembled);
    }

    // ---- step 13: publish ----
    deps.replaceDir(paths.jxDist, paths.dist);

    // ---- step 14 ----
    log(`build: ${summary.pages} page(s) written to ${paths.dist}`);
    const overrides = [
      ...assembly.shadowed.map((file) => `${file} (replaces the package's file)`),
      ...assembly.added.map((file) => `${file} (added)`),
      ...(hasJxFragment(config) ? [JX_FRAGMENT] : []),
    ];
    log(
      `build: overrides: ${overrides.length === 0 ? "none (every file comes from the package)" : overrides.join(", ")}`,
    );
    log(`build: to run Jx by hand on the assembled project: ${shellCommand(command)}`);
    return result(true, { ...assembled, pages: summary.pages });
  } finally {
    release();
  }
}
