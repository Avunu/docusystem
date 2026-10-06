// A fake world for the pipeline and the commands: the modules of the other work packages (config,
// preflight, lock, assemble, stage, lint, nav, post-build, assertions) replaced by small documented
// fakes that write real files into a temporary repository, so that what the pipeline decides, prints
// and publishes can be tested without them. The real modules are exercised by test/integration.
//
// What the fakes stand for:
//   preflight      steps 1 and 2 (WP1): returns the config and paths of the temporary repository
//   acquireLock    step 3 (WP2): records "lock" and "unlock"
//   assemble       step 4 (WP2): a root with the three pages, project.json and docs-search.json
//   stageSite      step 5 (WP3): reports what the test says, writes nothing
//   lintDocs       step 6 (WP3): returns the issues the test says
//   writeNav       step 7 (WP3): N pages, written to the nav file
//   runJx          step 9 (WP5's own spawn): prints what the test says and, when it exits 0, writes a
//                  site into the root's dist
//   runPostbuild, assertBuild   steps 11 and 12 (WP4): what the test says
// `replaceDir` is the real one (WP0), so that "published" and "left untouched" are about real files.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { replaceDir, writeJson } from "../../../src/lib/fsutil.js";
import type { PipelineDeps } from "../../../src/lib/pipeline.js";
import type {
  Assertion,
  DocsConfig,
  LintIssue,
  Manifest,
  NavData,
  Paths,
  PostbuildSummary,
  SkippedPath,
  StageResult,
} from "../../../src/lib/types.js";
import { tempDir } from "../../support/index.js";

export const FAKE_JX = "/fake/jx/bin/jx.js";

export interface World {
  /** The repository root. */
  dir: string;
  siteDir: string;
  config: DocsConfig;
  paths: Paths;
  deps: PipelineDeps;
  /** The order in which the fakes were called. */
  calls: string[];
  /** Everything the fakes were asked, for the tests that look at arguments. */
  seen: {
    assemble: Array<Parameters<PipelineDeps["assemble"]>[0]>;
    runJx: Array<{ command: string[]; cwd: string }>;
    postbuild: Array<{ config: DocsConfig & { branch: string } }>;
    assertions: Array<Parameters<PipelineDeps["assertBuild"]>[2]>;
    lockHeld: boolean[];
  };

  // ---- what the fakes answer (change before running) ----
  preflightErrors: string[];
  preflightWarnings: string[];
  assemblyErrors: string[];
  assemblyWarnings: string[];
  assemblySkipped: SkippedPath[];
  shadowed: string[];
  added: string[];
  catalog: "bundled" | "live";
  stage: Partial<StageResult>;
  lint: LintIssue[];
  navWarnings: string[];
  /** The number of documentation pages (the nav's `pages`). */
  navPages: number;
  jx: {
    code: number;
    /** The text of the run, or a function of the world (default: a clean run with the right count). */
    output?: string | ((world: World) => string);
    /** Throw instead of running (Jx could not be started). */
    throws?: Error;
  };
  postbuild: Partial<PostbuildSummary>;
  assertions: Assertion[];
  lockError?: Error;
  /** Increments with each site the fake Jx writes: `build 1`, `build 2`. */
  builds: number;
}

export interface WorldOptions {
  /** Extra files under the repository root (the docs, an existing dist, ...). */
  files?: Record<string, string>;
  config?: Partial<DocsConfig>;
}

export function makeWorld(options: WorldOptions = {}): World {
  const dir = tempDir("docusystem-world-");
  const siteDir = join(dir, "docs-site");
  const work = join(siteDir, ".docusystem");
  const root = join(work, "site");
  const paths: Paths = {
    siteDir,
    repoRoot: dir,
    docsDir: join(dir, "docs"),
    work,
    root,
    stagedDocs: join(root, ".generated", "docs"),
    navFile: join(root, ".generated", "nav.json"),
    jxDist: join(root, "dist"),
    dist: join(siteDir, "dist"),
    serve: join(work, "serve"),
    manifest: join(work, "manifest.json"),
    jxLog: join(work, "jx.log"),
    lock: join(work, "lock"),
  };
  const config: DocsConfig = {
    name: "Example",
    tagline: "A sample project.",
    slug: "example",
    platform: "general",
    repo: "https://github.com/Avunu/docusystem-example",
    domain: "example.avunu.net",
    license: "MIT",
    ...options.config,
  };
  mkdirSync(paths.docsDir, { recursive: true });
  mkdirSync(siteDir, { recursive: true });
  for (const [path, text] of Object.entries(options.files ?? {})) {
    const file = join(dir, ...path.split("/"));
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, text);
  }

  const world: World = {
    dir,
    siteDir,
    config,
    paths,
    calls: [],
    seen: { assemble: [], runJx: [], postbuild: [], assertions: [], lockHeld: [] },
    preflightErrors: [],
    preflightWarnings: [],
    assemblyErrors: [],
    assemblyWarnings: [],
    assemblySkipped: [],
    shadowed: [],
    added: [],
    catalog: "bundled",
    stage: {},
    lint: [],
    navWarnings: [],
    navPages: 4,
    jx: { code: 0 },
    postbuild: {},
    assertions: [{ ok: true, message: "CNAME equals the configured domain" }],
    builds: 0,
    deps: undefined as unknown as PipelineDeps,
  };

  let locked = false;
  const staticPages = 2;
  const docsPages = (): number => world.navPages;

  world.deps = {
    findSiteDir: () => {
      world.calls.push("findSiteDir");
      return siteDir;
    },
    preflight: () => {
      world.calls.push("preflight");
      if (world.preflightErrors.length > 0) {
        return { errors: world.preflightErrors, warnings: world.preflightWarnings };
      }
      return { config, paths, errors: [], warnings: world.preflightWarnings };
    },
    resolveBranch: () => "main",
    acquireLock: () => {
      world.calls.push("lock");
      if (world.lockError !== undefined) throw world.lockError;
      locked = true;
      return () => {
        locked = false;
        world.calls.push("unlock");
      };
    },
    assemble: async (args) => {
      world.calls.push("assemble");
      world.seen.assemble.push(args);
      world.seen.lockHeld.push(locked);
      mkdirSync(join(root, "pages"), { recursive: true });
      mkdirSync(join(root, "components"), { recursive: true });
      for (const page of ["index.json", "404.json", "[...path].json"]) {
        writeFileSync(join(root, "pages", page), "{}\n");
      }
      writeJson(join(root, "project.json"), {
        name: config.name,
        style: { "--color-text": "#000000" },
        content: { docs: { links: args.strict ? "error" : "warn" } },
      });
      writeJson(join(root, "components", "docs-search.json"), {
        style: {
          "& .hl": { backgroundColor: "color-mix(in srgb, var(--color-action) 22%, transparent)" },
        },
      });
      const files: Manifest["files"] = {
        "pages/index.json": "package",
        "pages/404.json": "package",
        "pages/[...path].json": "package",
        "project.json": "generated",
        "components/docs-search.json": "package",
      };
      return {
        manifest: {
          docusystem: "0.1.0",
          runtime: "node 24.0.0",
          jx: { "@jxsuite/compiler": "5.0.0" },
          files,
          shadowed: world.shadowed,
          added: world.added,
          catalog: world.catalog,
          strict: args.strict,
        },
        shadowed: world.shadowed,
        added: world.added,
        skipped: world.assemblySkipped,
        warnings: world.assemblyWarnings,
        errors: world.assemblyErrors,
      };
    },
    stageSite: () => {
      world.calls.push("stage");
      return {
        files: 5,
        written: 5,
        removed: 0,
        links: [],
        comments: [],
        skipped: [],
        ...world.stage,
      };
    },
    lintDocs: () => {
      world.calls.push("lint");
      return world.lint;
    },
    formatIssue: (issue, o) =>
      `${o?.prefix ?? "docs"}/${issue.file}:${issue.line}  ${issue.message}`,
    writeNav: () => {
      world.calls.push("nav");
      const urls = Array.from({ length: docsPages() }, (_, i) =>
        i === 0 ? "/docs/" : `/docs/page-${i}/`,
      );
      const nav: NavData = {
        home: { label: "Home", url: "/docs/" },
        loose: [],
        sections: [],
        expandAll: true,
        pages: Object.fromEntries(
          urls.map((url, i) => [
            url,
            {
              title: url,
              description: "",
              section: "",
              prev: null,
              next: null,
              edit: i === 0 ? "README.md" : `page-${i}.md`,
            },
          ]),
        ),
        flat: [],
        featured: [],
      };
      writeJson(paths.navFile, nav);
      return { nav, warnings: world.navWarnings, pages: docsPages() };
    },
    jxCli: () => FAKE_JX,
    runJx: async (command, o) => {
      world.calls.push("jx");
      world.seen.runJx.push({ command, cwd: o.cwd });
      if (world.jx.throws !== undefined) throw world.jx.throws;
      const text = world.jx.output;
      const output =
        typeof text === "function"
          ? text(world)
          : (text ??
            `Building site from ${root}...\n\nDone: ${docsPages() + staticPages} routes → 40 files\n`);
      for (const line of output.replace(/\n$/, "").split("\n")) o.onLine?.(line, "stdout");
      if (world.jx.code === 0) {
        world.builds++;
        mkdirSync(join(paths.jxDist, "docs"), { recursive: true });
        writeFileSync(join(paths.jxDist, "index.html"), `<html>build ${world.builds}</html>\n`);
        writeFileSync(
          join(paths.jxDist, "docs", "index.html"),
          `<html>docs ${world.builds}</html>\n`,
        );
        writeFileSync(join(paths.jxDist, "404.html"), "<html>not found</html>\n");
      }
      return { code: world.jx.code, output };
    },
    runPostbuild: (_dist, cfg) => {
      world.calls.push("postbuild");
      world.seen.postbuild.push({ config: cfg });
      return {
        pages: docsPages() + staticPages,
        warnings: [],
        markdownCopies: 0,
        sitemapUrls: docsPages() + 1,
        searchTitles: 0,
        repoLinks: [],
        canonicals: docsPages() + 1,
        cname: true,
        notFound: true,
        ...world.postbuild,
      };
    },
    assertBuild: (_root, _dist, expected) => {
      world.calls.push("assert");
      world.seen.assertions.push(expected);
      return world.assertions;
    },
    replaceDir: (from, to) => {
      world.calls.push("publish");
      replaceDir(from, to);
    },
  };
  return world;
}

/** What is in `<site>/dist`, as `path: contents` (a quick way to check that a site was or was not published). */
export function distFiles(world: World): Record<string, string> {
  const out: Record<string, string> = {};
  const index = join(world.paths.dist, "index.html");
  if (existsSync(index)) out["index.html"] = readFileSync(index, "utf8");
  const docs = join(world.paths.dist, "docs", "index.html");
  if (existsSync(docs)) out["docs/index.html"] = readFileSync(docs, "utf8");
  return out;
}

/** Puts a previously published site into `<site>/dist`, to see whether a failed build leaves it alone. */
export function publishedBefore(world: World): Record<string, string> {
  mkdirSync(join(world.paths.dist, "docs"), { recursive: true });
  writeFileSync(
    join(world.paths.dist, "index.html"),
    "<html>the site from the last good build</html>\n",
  );
  writeFileSync(join(world.paths.dist, "docs", "index.html"), "<html>last docs</html>\n");
  writeFileSync(join(world.paths.dist, "extra.txt"), "only in the old site\n");
  return { ...distFiles(world), "extra.txt": "only in the old site\n" };
}
