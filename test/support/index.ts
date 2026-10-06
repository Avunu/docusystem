// Shared helpers for tests (owned by WP0): temporary trees, fixture paths and git repositories.
// Import from "../support/index.js".
export { FIXTURES, REPO_ROOT, fixture } from "./paths.js";
export { git, initRepo } from "./git.js";
export { listTree, readTree, writeTree, type TreeEntry, type TreeSpec } from "./tree.js";
export { at, tempDir } from "./tmp.js";
