import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The root of this repository (the package folder). */
export const REPO_ROOT: string = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** `test/fixtures`: input trees that tests read; they are files, not tests, and are not formatted. */
export const FIXTURES: string = join(REPO_ROOT, "test", "fixtures");

/** A path under `test/fixtures`. */
export const fixture = (...parts: string[]): string => join(FIXTURES, ...parts);
