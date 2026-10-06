import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll } from "vitest";
import { REPO_ROOT } from "../support/index.js";

export { REPO_ROOT };

const kept: string[] = [];
afterAll(() => {
  for (const dir of kept.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A folder that lives until the end of the test file, for what a `beforeAll` makes (`tempDir` of the
 * shared support removes its folders after every test).
 */
export function suiteDir(prefix = "docusystem-e2e-"): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  kept.push(dir);
  return dir;
}

export interface Run {
  code: number;
  stdout: string;
  stderr: string;
  /** stdout and stderr, as a person would have seen them. */
  output: string;
}

/** Runs one of the scripts of this repository under the node that runs the tests. */
export function runScript(
  name: string,
  args: string[],
  options: Pick<SpawnSyncOptions, "cwd" | "env" | "timeout"> = {},
): Run {
  const result = spawnSync(process.execPath, [join(REPO_ROOT, "scripts", name), ...args], {
    encoding: "utf8",
    cwd: REPO_ROOT,
    ...options,
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  return { code: result.status ?? -1, stdout, stderr, output: `${stdout}${stderr}` };
}

/** `npm pack` of a folder into `into`; returns the tarball's path. */
export function pack(folder: string, into: string): string {
  const result = spawnSync("npm", ["pack", "--json", "--pack-destination", into], {
    cwd: folder,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`npm pack failed in ${folder}: ${result.stderr}`);
  const [packed] = JSON.parse(result.stdout) as Array<{ filename: string }>;
  return join(into, packed!.filename);
}

export interface BuildOptions {
  site?: { name: string; tagline: string; domain: string };
  pages?: Array<{ route: string; title: string; h1: string; callouts?: number }>;
  hrefs?: string[];
  srcs?: string[];
  breaks?: string[];
  extraFiles?: Record<string, string>;
}

interface Builder {
  buildDist: (dir: string, options?: BuildOptions) => string;
  configOf: (site?: { name: string; tagline: string; domain: string }) => Record<string, string>;
  SITE: { name: string; tagline: string; domain: string };
  PAGES: Array<{ route: string; title: string; h1: string; callouts: number }>;
}

/** The hand-built site writer of fixtures/stub-cli (plain JavaScript, so that the stand-in package can ship it). */
export async function builder(): Promise<Builder> {
  const file = join(REPO_ROOT, "test", "e2e", "fixtures", "stub-cli", "builder.mjs");
  return (await import(pathToFileURL(file).href)) as Builder;
}

/** A module of scripts/ (plain JavaScript; each exports what its tests need and runs nothing on import). */
export async function script<T>(name: string): Promise<T> {
  return (await import(pathToFileURL(join(REPO_ROOT, "scripts", name)).href)) as T;
}
