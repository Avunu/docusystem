// Helpers of the assemble tests (WP2): a throwaway repository with a site folder, the `Paths` of 3.2 of
// the architecture decision record built without WP1's `pathsFor` (which is a stub until WP1 merges),
// and the package `site/` fixture that stands in for WP7's until it lands.
import { cpSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AssembleArgs } from "../../src/lib/assemble.js";
import type { DocsConfig, Paths } from "../../src/lib/types.js";
import { tempDir, type TreeSpec, writeTree } from "../support/index.js";

/** A minimal but real package `site/` (it builds with the pinned Jx): `test/assemble/fixtures/site`. */
export const SITE_SOURCE: string = fileURLToPath(new URL("fixtures/site", import.meta.url));

/** The package's real `site/` folder, once WP7 has added it. */
export const REAL_SITE: string = fileURLToPath(new URL("../../site", import.meta.url));

export const CONFIG: DocsConfig = {
  name: "Example",
  tagline: "A sample project for the tests.",
  slug: "example",
  platform: "general",
  repo: "https://github.com/Avunu/docusystem-example",
  domain: "example.avunu.net",
  license: "MIT",
};

/** The `Paths` of 3.2, as WP1's `pathsFor` computes them. */
export function makePaths(repoRoot: string, siteDir: string, docsDir: string): Paths {
  const work = join(siteDir, ".docusystem");
  const root = join(work, "site");
  return {
    siteDir,
    repoRoot,
    docsDir,
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

export interface Shell {
  /** The repository root (it has a `.git` folder). */
  repo: string;
  /** `<repo>/docs-site` */
  site: string;
  paths: Paths;
}

/**
 * A repository with `docs/README.md`, a `docs-site/` folder and whatever else `files` adds (paths
 * relative to the repository root). `docs` is the Markdown folder relative to the repository root.
 */
export function makeShell(files: TreeSpec = {}, o: { docs?: string } = {}): Shell {
  const repo = tempDir();
  writeTree(repo, {
    ".git/HEAD": "ref: refs/heads/main\n",
    "docs/README.md": "# Home\n",
    ...files,
  });
  const site = join(repo, "docs-site");
  writeTree(site, {});
  return { repo, site, paths: makePaths(repo, site, join(repo, o.docs ?? "docs")) };
}

/** Assemble arguments for a shell: lenient, branch `main`, the example configuration. */
export function argsFor(shell: Shell, extra: Partial<AssembleArgs> = {}): AssembleArgs {
  return {
    paths: shell.paths,
    config: CONFIG,
    branch: "main",
    strict: false,
    env: {},
    ...extra,
  };
}

/** A copy of the fixture package `site/` in a temp folder, for tests that change the package's files. */
export function copySite(): string {
  const dir = join(tempDir(), "site");
  cpSync(SITE_SOURCE, dir, { recursive: true });
  return dir;
}
