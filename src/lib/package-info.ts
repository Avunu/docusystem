// What this package knows about itself, read from its own package.json (never from the consumer's),
// which sits two levels above both src/lib/ and dist/lib/.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The package's own folder: the one with package.json, site/, scaffold/ and dist/. */
export const packageRoot: string = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

interface PackageJson {
  name: string;
  version: string;
}

const info = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as PackageJson;

/** `@avunu/docusystem` */
export const name: string = info.name;
/** The installed version, `MAJOR.MINOR.PATCH`. */
export const version: string = info.version;
/** The major of `version`: 0 before the first stable release. */
export const major: number = Number.parseInt(version, 10);

/** The repository that publishes the package and holds the reusable workflows. */
export const REPOSITORY = "Avunu/docusystem";

/** The oldest Node this package runs on (the `engines` field says the same). */
export const NODE_FLOOR = "22.19.0";

/**
 * One integer says whether the reusable workflows and the CLI can work together: the command line the
 * workflow runs, the environment it sets and the output path `<site>/dist`. `docs-build.yml` sets the
 * same number in DOCUSYSTEM_WORKFLOW_CONTRACT; the CLI exits 3 on a mismatch. It changes only when
 * the two stop being able to work together, and then in a package major (from 1.0) or minor (0.x).
 */
export const WORKFLOW_CONTRACT = 1;
