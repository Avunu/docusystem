// Shared helpers for tests (owned by WP0): temporary trees, fixture paths, git repositories and an
// in-process command line. Import from "../support/index.js".
export { FIXTURES, REPO_ROOT, fixture } from "./paths.js";
export { git, initRepo } from "./git.js";
export { runCli, testContext, type CliResult } from "./run.js";
export { listTree, readTree, writeTree, type TreeEntry, type TreeSpec } from "./tree.js";
export { at, tempDir } from "./tmp.js";
