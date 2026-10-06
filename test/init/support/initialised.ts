// A repository in the state a maintainer is in after `docusystem init`: used by the tests of upgrade,
// doctor and eject, which start from what init writes and change one thing at a time.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runInit } from "../../../src/commands/init.js";
import type { TreeSpec } from "../../support/index.js";
import { exec, makeRepo, SHA } from "./shell.js";

/**
 * A repository in the state a maintainer is in after `docusystem init`, `npm install` and writing
 * the home page: the shell, a lockfile, docs/README.md. `doctor` has nothing to say about it.
 */
export async function initialisedRepo(
  o: { origin?: string | null; files?: TreeSpec } = {},
): Promise<string> {
  const root = makeRepo(o);
  const { code, err } = await exec(
    (ctx) => runInit(ctx, { resolvePin: () => ({ sha: SHA, reason: null }) }),
    { command: "init", cwd: root },
  );
  if (code !== 0) throw new Error(`init failed in the test setup: ${err}`);
  writeFileSync(join(root, "docs-site", "package-lock.json"), "{}\n");
  if (!existsSync(join(root, "docs", "README.md"))) {
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "docs", "README.md"), "# Home\n");
  }
  return root;
}
