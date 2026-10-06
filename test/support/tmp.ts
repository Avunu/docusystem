import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";

const made: string[] = [];

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A fresh, empty folder, removed after the test. The path is a real path (no symbolic link in it), so
 * that comparisons with what the code under test resolves do not depend on how the machine lays out
 * its temporary folder (macOS has /var -> /private/var).
 */
export function tempDir(prefix = "docusystem-test-"): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  made.push(dir);
  return dir;
}

/** `join` for a `/`-separated path under `root`. */
export const at = (root: string, path: string): string => join(root, ...path.split("/"));
