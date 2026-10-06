// The programmatic surface (section 4.3): exactly this, and kept deliberately small, because everything
// exported here is covered by semantic versioning. The CLI is the interface most consumers use;
// `site/` and `scaffold/` are read by path inside the package and are internal.
export { PLATFORMS } from "./lib/platforms.js";
export type { Platform } from "./lib/platforms.js";
export type { DocsConfig } from "./lib/types.js";
export { readConfig, validateConfig } from "./lib/config.js";
export { name, version, WORKFLOW_CONTRACT } from "./lib/package-info.js";
