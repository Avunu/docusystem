// Finding the Jx packages this version of docusystem depends on, and making them visible from the
// generated project root.
//
// The package picks Jx (invariant 8 of the architecture decision record): the four `@jxsuite/*`
// packages are exact-pinned in this package's own `package.json` and are looked up from the folder
// this file lives in, never from the consumer's project. A consumer that happens to depend on its own,
// different `@jxsuite/compiler` is therefore irrelevant: the package manager keeps this package's copy
// next to this package (nested under `node_modules/@avunu/docusystem/` when the versions differ), and
// `linkJxPackages` makes exactly that copy the one the assembled root resolves.
//
// Jx's own exports maps point at TypeScript, which Node refuses to load from `node_modules`
// (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), and its `bin` is not exposed by them either. So Jx
// is run as a child process of `process.execPath` on `<compiler>/bin/jx.js`, and what this file finds
// is the package folders, not modules to import.
import { mkdirSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { removeInside } from "./fsutil.js";

/** The Jx packages this version depends on, exact-pinned in package.json. */
export const JX_PACKAGES = [
  "@jxsuite/compiler",
  "@jxsuite/parser",
  "@jxsuite/runtime",
  "@jxsuite/search",
] as const;

/** `name` and `version` of the package.json in `dir`, or null when there is none (or it is not JSON). */
function readManifest(dir: string): { name?: string; version?: string } | null {
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      name?: string;
      version?: string;
    };
  } catch {
    return null;
  }
}

/**
 * The installed folder (a real path) of the package `pkg` as the code in the folder `from` would
 * resolve it. This is `packageDir` with the starting point exposed, so that a test can stand in a
 * consumer-shaped tree; the package itself always starts from its own location.
 *
 * Node's resolver finds the package's entry file, and the folder is the nearest ancestor of that file
 * whose package.json carries the package's name. That works whatever the exports map exposes and
 * whichever way the package manager laid the tree out (hoisted, nested, isolated, a Nix store).
 */
export function findPackageDir(pkg: string, from: string): string {
  const require = createRequire(join(from, "noop.js"));
  let entry: string;
  try {
    entry = require.resolve(pkg);
  } catch (error) {
    // A package whose exports map has no "." entry has no entry file to start from: look in the
    // folders Node would search for it instead.
    for (const base of require.resolve.paths?.(pkg) ?? []) {
      const dir = join(base, ...pkg.split("/"));
      if (readManifest(dir)?.name === pkg) return realpathSync(dir);
    }
    throw new Error(
      `cannot find the installed package ${pkg}, which docusystem needs: ${(error as Error).message}`,
      { cause: error },
    );
  }
  let dir = dirname(entry);
  for (;;) {
    if (readManifest(dir)?.name === pkg) return realpathSync(dir);
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        `cannot find the folder of the installed package ${pkg} (entry file ${entry})`,
      );
    }
    dir = parent;
  }
}

/** The installed folder of one of this package's own dependencies. */
export function packageDir(pkg: string): string {
  return findPackageDir(pkg, dirname(fileURLToPath(import.meta.url)));
}

/** `<@jxsuite/compiler>/bin/jx.js`: what `node_modules/.bin/jx` would be if Jx were a direct dependency. */
export function jxCli(): string {
  return join(packageDir("@jxsuite/compiler"), "bin", "jx.js");
}

/** The installed versions of JX_PACKAGES, by package name. */
export function jxVersions(): Record<string, string> {
  const versions: Record<string, string> = {};
  for (const pkg of JX_PACKAGES) {
    const version = readManifest(packageDir(pkg))?.version;
    if (version === undefined) throw new Error(`the installed package ${pkg} has no version`);
    versions[pkg] = version;
  }
  return versions;
}

/**
 * Links the four Jx packages into `<root>/node_modules/@jxsuite/` and returns their versions.
 *
 * With a hoisted install the packages are visible from the root already (Node walks up), but with an
 * isolated linker (`bun install --linker isolated`, pnpm) a transitive dependency of the CLI is not,
 * and a consumer's own different copy would win when it is. Linking always, instead of only when
 * needed, makes this package's copies the only ones the root can see and keeps one code path. The
 * links are directory links (a `junction` on Windows, which needs no privilege; an ordinary symbolic
 * link elsewhere) to real paths, and they are the only links the CLI ever writes.
 */
export function linkJxPackages(root: string): Record<string, string> {
  const versions = jxVersions();
  for (const pkg of JX_PACKAGES) {
    const link = join(root, "node_modules", ...pkg.split("/"));
    mkdirSync(dirname(link), { recursive: true });
    removeInside(link, root); // idempotent: removes a link, never what it points to
    symlinkSync(packageDir(pkg), link, "junction");
  }
  return versions;
}
