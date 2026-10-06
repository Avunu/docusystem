import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** `test/init/fixtures`: the trees and files of the init tests (copies of real repository files, a fake catalog). */
export const INIT_FIXTURES: string = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
);

/** A path under `test/init/fixtures`. */
export const initFixture = (...parts: string[]): string => join(INIT_FIXTURES, ...parts);

/** The text of a file under `test/init/fixtures`. */
export const readFixture = (...parts: string[]): string =>
  readFileSync(initFixture(...parts), "utf8");
