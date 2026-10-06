// Helpers for the content tests (WP3): trees of files in a throwaway folder, and the Paths of a
// repository laid out as section 3.2 of the architecture decision record describes it (the real
// `pathsFor` is WP1's; this one is only for tests of modules that take a Paths).
import { join } from "node:path";
import type { Paths } from "../../src/lib/types.js";
import { canSymlink, tempDir, writeTree, type TreeSpec } from "../support/index.js";

/**
 * Whether the tests that create symbolic links can run here: everywhere, except on a Windows account
 * that may not create them (see `canSymlink`). The windows-latest runner may.
 */
export const symlinksWork: boolean = canSymlink();

/** A temporary folder holding `files` (path -> text, or a symlink entry); removed after the test. */
export function makeTree(files: TreeSpec = {}): string {
  return writeTree(tempDir("docusystem-content-"), files);
}

/**
 * The paths of a run for a repository at `repoRoot` whose site folder is `docs-site` and whose
 * Markdown folder is `docs` (both overridable).
 */
export function pathsIn(repoRoot: string, o: { site?: string; docs?: string } = {}): Paths {
  const siteDir = join(repoRoot, o.site ?? "docs-site");
  const work = join(siteDir, ".docusystem");
  const root = join(work, "site");
  return {
    siteDir,
    repoRoot,
    docsDir: join(repoRoot, o.docs ?? "docs"),
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
