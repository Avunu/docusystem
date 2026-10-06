#!/usr/bin/env node
// Refreshes the project catalog that ships in the package (site/data/projects.snapshot.json) from the
// live one, https://avunu.net/projects.json.
//
//   node scripts/sync-catalog.mjs [--check] [--url <address>] [--out <file>] [--timeout <ms>] [--soft]
//
// Without options it fetches the live catalog and, if it is a version 1 catalog that differs from the
// bundled one, replaces the bundled file; the lines it prints say what changed. With --check it writes
// nothing and exits 1 when the bundled file differs (the weekly `catalog.yml` workflow and a release
// gate use it). "Differs" ignores the catalog's own `generated` stamp: a catalog that was regenerated
// without a change is the same catalog, and would otherwise propose a release every week.
//
// avunu.net does not publish projects.json yet. Until it does, and whenever the answer is not a
// catalog, the script says so as a notice and exits 0 with nothing changed: there is no news to act on.
// Network trouble (no answer, a timeout, a server error) is a failure, exit 1, unless --soft turns it
// into a warning. Exit codes: 0 done or nothing to do; 1 the check found a difference, or a failure;
// 2 usage.
//
// The logic lives in src/lib/catalog.ts (one source for the contract). This script runs the compiled
// copy in dist/, and builds it first (`npm run build`) when dist/ is missing or older than src/.
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const USAGE = [
  "Usage: node scripts/sync-catalog.mjs [--check] [--url <address>] [--out <file>] [--timeout <ms>] [--soft]",
  "",
  "  --check          write nothing; exit 1 when the bundled catalog differs from the live one",
  "  --url <address>  the catalog to fetch (default https://avunu.net/projects.json)",
  "  --out <file>     the file to refresh (default site/data/projects.snapshot.json)",
  "  --timeout <ms>   how long to wait for the answer (default 5000)",
  "  --soft           report network trouble as a warning and exit 0",
].join("\n");

/** The newest modification time of any file under `dir` (0 when there is none). */
function newestMtime(dir) {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(path) : statSync(path).mtimeMs);
  }
  return newest;
}

/** Whether the compiled `entry` is missing or older than anything under src/. */
function isStale(root, entry) {
  try {
    return statSync(entry).mtimeMs < newestMtime(join(root, "src"));
  } catch {
    return true;
  }
}

/**
 * The compiled catalog module of this package: built first when dist/ is missing or out of date, so
 * that `npm run sync-catalog` works in a fresh checkout after `npm ci`.
 */
export async function loadLibrary(root = packageRoot) {
  const entry = join(root, "dist", "lib", "catalog.js");
  if (isStale(root, entry)) {
    console.error("sync-catalog: building dist/ first (npm run build)");
    const npm = process.env.npm_execpath;
    const result =
      npm === undefined
        ? spawnSync("npm", ["run", "--silent", "build"], { cwd: root, stdio: ["ignore", 2, 2] })
        : spawnSync(process.execPath, [npm, "run", "--silent", "build"], {
            cwd: root,
            stdio: ["ignore", 2, 2],
          });
    if (result.status !== 0)
      throw new Error("npm run build failed: fix the build, then run this again");
  }
  // The modification time in the address: a module that was built again is not the cached old one.
  return import(`${pathToFileURL(entry).href}?built=${statSync(entry).mtimeMs}`);
}

/** The catalog document at `file`, or null when there is none or it is not JSON. */
function readCatalog(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Replaces `file` with `contents` so that a reader sees the old file or the new one. */
function replaceFile(file, contents) {
  const temporary = `${file}.tmp-${process.pid}`;
  try {
    writeFileSync(temporary, contents);
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/**
 * Runs the script and returns its exit code. `io` replaces standard output and error; `load` supplies
 * the catalog module (tests pass the TypeScript source, the default is dist/).
 */
export async function main(argv, io = {}, load = loadLibrary) {
  const out = io.stdout ?? ((line) => console.log(line));
  const err = io.stderr ?? ((line) => console.error(line));
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        check: { type: "boolean" },
        url: { type: "string" },
        out: { type: "string" },
        timeout: { type: "string" },
        soft: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: false,
    }));
  } catch (error) {
    err(`sync-catalog: ${error.message}`);
    err(USAGE);
    return 2;
  }
  if (values.help) {
    out(USAGE);
    return 0;
  }
  const timeoutMs = values.timeout === undefined ? undefined : Number(values.timeout);
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 1)) {
    err(`sync-catalog: --timeout must be a whole number of milliseconds (got "${values.timeout}")`);
    return 2;
  }

  let library;
  try {
    library = await load();
  } catch (error) {
    err(`sync-catalog: ${error.message}`);
    return 1;
  }
  const file = values.out === undefined ? library.bundledCatalogFile() : resolve(values.out);
  const label = values.out === undefined ? "the bundled catalog" : file;

  const scratch = mkdtempSync(join(tmpdir(), "sync-catalog-"));
  try {
    const fetched = join(scratch, "projects.json");
    const result = await library.syncCatalog({ url: values.url, out: fetched, timeoutMs });

    if (result.outcome === "not-live" || result.outcome === "invalid") {
      out(`sync-catalog: notice: ${result.message}; ${label} stays as it is`);
      return 0;
    }
    if (!result.ok) {
      if (values.soft) {
        out(`sync-catalog: warning: ${result.message}; ${label} stays as it is`);
        return 0;
      }
      err(`sync-catalog: ${result.message}`);
      return 1;
    }

    const next = readFileSync(fetched, "utf8");
    const current = readCatalog(file);
    const changes =
      current === null
        ? [`${file} is missing or not JSON`]
        : library.catalogChanges(current, JSON.parse(next));
    const count = JSON.parse(next).projects.length;
    if (changes.length === 0) {
      out(`sync-catalog: ${label} is current (${count} projects)`);
      return 0;
    }
    if (values.check) {
      err(`sync-catalog: ${label} differs from the live catalog:`);
      for (const change of changes) err(`  ${change}`);
      err("Run npm run sync-catalog to update it.");
      return 1;
    }
    replaceFile(file, next);
    out(`sync-catalog: updated ${label} (${count} projects):`);
    for (const change of changes) out(`  ${change}`);
    return 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// Run as a script, not when a test imports `main`.
const invoked = process.argv[1] === undefined ? null : realpathSync(process.argv[1]);
if (invoked === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2));
}
