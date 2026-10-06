// Helpers for the integration tests: a temporary repository made from a fixture tree, and the pipeline
// with the REAL pinned Jx and stand-ins for the modules of the other work packages. The stand-ins are
// the minimum that makes a Jx project root out of a docs tree (documented below); everything the
// pipeline decides, and Jx itself, is real. test/integration/canary.test.ts runs the same trees through
// the real modules once they are merged.
import {
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import type { PipelineDeps } from "../../src/lib/pipeline.js";
import { spawnCommand } from "../../src/lib/pipeline.js";
import { replaceDir, writeJson } from "../../src/lib/fsutil.js";
import type { DocsConfig, NavData, Paths } from "../../src/lib/types.js";
import { REPO_ROOT, fixture, git, tempDir } from "../support/index.js";

/** What WP2's `jxCli()` returns: the Jx CLI of the Jx packages this repository depends on. */
export const JX_CLI = join(REPO_ROOT, "node_modules", "@jxsuite", "compiler", "bin", "jx.js");

export interface Repo {
  /** The repository root (a fresh `git init`). */
  dir: string;
  siteDir: string;
  docsDir: string;
  config: DocsConfig;
  paths: Paths;
}

/** Computes every path of a run the way WP1's `pathsFor` does, for the layout `docs/` + `docs-site/`. */
function pathsOf(dir: string): Paths {
  const siteDir = join(dir, "docs-site");
  const work = join(siteDir, ".docusystem");
  const root = join(work, "site");
  return {
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
}

/**
 * A temporary git repository holding a copy of `test/fixtures/<fixtureDir>` (a `docs/` and a
 * `docs-site/docusystem.config.json`). `files` are written on top of it (`docs/x.md`: text), so that a
 * test can break a clean tree.
 */
export function repoFrom(fixtureDir: string, files: Record<string, string> = {}): Repo {
  const dir = tempDir("docusystem-it-");
  cpSync(fixture(fixtureDir), dir, { recursive: true });
  for (const [path, text] of Object.entries(files)) {
    const file = join(dir, ...path.split("/"));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  git(dir, "init", "--initial-branch", "main");
  const paths = pathsOf(dir);
  const config = JSON.parse(
    readFileSync(join(paths.siteDir, "docusystem.config.json"), "utf8"),
  ) as DocsConfig;
  return { dir, siteDir: paths.siteDir, docsDir: paths.docsDir, config, paths };
}

/** The Markdown files below `dir`, `/`-separated, sorted. */
function markdownIn(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...markdownIn(path, base));
    else if (entry.name.endsWith(".md")) out.push(relative(base, path).split("\\").join("/"));
  }
  return out.sort();
}

export interface JxRepoOptions {
  /** Text for files of the root, written over the copy of test/fixtures/jx-root (`pages/index.json`: ...). */
  rootFiles?: Record<string, string>;
}

/**
 * The pipeline's neighbours for the real-Jx tests. Real: the Jx run (`spawnCommand` on the pinned Jx),
 * the publish (`replaceDir`), and everything in pipeline.ts and strict.ts. Stand-ins, each for the
 * module that will replace it:
 *   findSiteDir, preflight   WP1  the repository's site folder and its config file, unvalidated
 *   acquireLock              WP2  none (the lock is tested with fakes in test/commands, and for real in canary.test.ts)
 *   assemble                 WP2  a copy of test/fixtures/jx-root, project.json with `links` by strictness
 *                                 (what WP2's generateProject does), the junction to the Jx packages
 *   stageSite                WP3  a plain copy of docs/ into .generated/docs (no link rewriting)
 *   lintDocs                 WP3  nothing
 *   writeNav                 WP3  one nav page per Markdown file, none deduplicated (that is WP3's job,
 *                                 and what lets the test see Jx drop a route)
 *   runPostbuild, assertBuild WP4 nothing, and one assertion that the home page was emitted
 */
export function jxDeps(repo: Repo, options: JxRepoOptions = {}): PipelineDeps {
  const { paths, config } = repo;
  return {
    findSiteDir: () => repo.siteDir,
    preflight: () => ({ config, paths, errors: [], warnings: [] }),
    resolveBranch: () => "main",
    acquireLock: () => () => {},
    assemble: async (args) => {
      rmSync(paths.root, { recursive: true, force: true });
      cpSync(fixture("jx-root"), paths.root, { recursive: true });
      for (const [path, text] of Object.entries(options.rootFiles ?? {})) {
        writeFileSync(join(paths.root, ...path.split("/")), text);
      }
      const projectFile = join(paths.root, "project.json");
      const project = JSON.parse(readFileSync(projectFile, "utf8")) as {
        content: { docs: { links: string } };
      };
      project.content.docs.links = args.strict ? "error" : "warn";
      writeJson(projectFile, project);
      mkdirSync(join(paths.root, "node_modules"), { recursive: true });
      symlinkSync(
        join(REPO_ROOT, "node_modules", "@jxsuite"),
        join(paths.root, "node_modules", "@jxsuite"),
        "dir",
      );
      return {
        manifest: {
          docusystem: "0.0.0-test",
          runtime: `node ${process.versions.node}`,
          jx: {},
          files: {},
          shadowed: [],
          added: [],
          catalog: "bundled",
          strict: args.strict,
        },
        shadowed: [],
        added: [],
        skipped: [],
        warnings: [],
        errors: [],
      };
    },
    stageSite: () => {
      rmSync(paths.stagedDocs, { recursive: true, force: true });
      cpSync(paths.docsDir, paths.stagedDocs, { recursive: true });
      return {
        files: markdownIn(paths.docsDir).length,
        written: 0,
        removed: 0,
        links: [],
        comments: [],
        skipped: [],
      };
    },
    lintDocs: () => [],
    formatIssue: (issue) => `docs/${issue.file}:${issue.line}  ${issue.message}`,
    writeNav: () => {
      const files = markdownIn(paths.docsDir);
      const urls = files.map((file) => {
        const base = file.replace(/\.md$/, "").replace(/(^|\/)README$/, "");
        return base === "" ? "/docs/" : `/docs/${base}/`;
      });
      const nav: NavData = {
        home: { label: config.name, url: "/docs/" },
        loose: [],
        sections: [],
        expandAll: true,
        pages: Object.fromEntries(
          urls.map((url) => [
            url,
            { title: url, description: "", section: "", prev: null, next: null, edit: "" },
          ]),
        ),
        flat: [],
        featured: [],
      };
      writeJson(paths.navFile, nav);
      return { nav, warnings: [], pages: urls.length };
    },
    jxCli: () => JX_CLI,
    runJx: spawnCommand,
    runPostbuild: () => ({
      pages: 0,
      warnings: [],
      markdownCopies: 0,
      sitemapUrls: 0,
      searchTitles: 0,
      repoLinks: [],
      canonicals: 0,
      cname: false,
      notFound: false,
    }),
    assertBuild: (_root, dist) => [
      {
        ok: readdirSync(dist).includes("index.html"),
        message: "the home page was emitted",
      },
    ],
    replaceDir,
  };
}

/** The environment of a real Jx run: this process's own (the native image library may need its library path), CI off. */
export function jxEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.CI;
  delete env.DOCUSYSTEM_LENIENT;
  delete env.GITHUB_ACTIONS;
  return { ...env, ...extra };
}
