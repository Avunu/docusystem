// Helpers for the tests of the output modules (WP4): the hand-built site of test/output/fixtures/site
// (a project root and the Jx output post-processed from it) copied to a temporary folder, and small
// edit functions that refuse to be no-ops, so that a failing-fixture test cannot pass by changing
// nothing.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "../support/index.js";

/** test/output/fixtures */
export const OUTPUT_FIXTURES: string = fileURLToPath(new URL("./fixtures", import.meta.url));

export interface Site {
  /** The project root: `components/*.json` say which custom elements are registered. */
  root: string;
  /** The built, post-processed site (the fixture is named `built` because `dist` is git-ignored). */
  dist: string;
}

/** A private copy of the fixture site that a test may change. */
export function copySite(): Site {
  const base = tempDir("docusystem-output-");
  cpSync(join(OUTPUT_FIXTURES, "site"), base, { recursive: true });
  return { root: join(base, "root"), dist: join(base, "built") };
}

/** Rewrites a file; `change` receives its text. Throws when the file does not exist. */
export function edit(file: string, change: (text: string) => string): void {
  writeFileSync(file, change(readFileSync(file, "utf8")));
}

/** `text` with `from` replaced by `to`; throws when `from` is not in `text` (the edit would be a no-op). */
export function swap(text: string, from: string | RegExp, to: string): string {
  const out = text.replace(from, to);
  if (out === text) throw new Error(`the fixture does not contain ${String(from)}`);
  return out;
}

/** Writes a file with its folders. */
export function put(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** Removes a file or folder that must exist. */
export function drop(path: string): void {
  if (!existsSync(path)) throw new Error(`${path} is not in the fixture`);
  rmSync(path, { recursive: true });
}
