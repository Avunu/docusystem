// The overrides of a shell (rung 3 of the ladder in 6.1 of the architecture decision record):
// `<site>/overrides/{components,layouts,pages}/**` replace or add Jx files of the package, and every
// override costs the upgradeability of the file it replaces. Two things keep that cost visible:
//
// - `docusystem eject` copies a package file into `overrides/` and records, in
//   `overrides/.ejected.json`, the version it came from and the SHA-256 of the package's file at that
//   moment: `{"components/docs-footer.json": {"from": "0.1.0", "sha256": "..."}}`;
// - `overrideFindings` (what `doctor` prints) compares that record with the installed package.
//
// The four states of an override of a package file, and how they are reported:
//
//   current      ok       the package's file is the one that was copied
//   changed      warning  the package's file has changed since the copy: diff and merge, or delete
//   not ejected  warning  nothing was recorded (a hand-made replacement), so drift cannot be checked
//   stale        error    the record names a file that the installed package no longer ships
//
// A file in `overrides/` that no package file has the name of is an addition (a page, layout or
// component of the site's own) and is not reported.
import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { copyFile, ensureRealDir, sha256, writeJson } from "./fsutil.js";
import { version } from "./package-info.js";
import { packageSiteDir } from "./project.js";
import type { Finding } from "./types.js";

/** The folders of `overrides/` (and of the package's `site/`) that hold Jx files. */
export const OVERRIDE_DIRS = ["components", "layouts", "pages"] as const;

/**
 * How the `jx` setting is named wherever the overrides of a site are listed (the build summary,
 * `info`, the CI summary, `doctor`): it changes the package's project.json, so a site that sets it
 * does not simply follow the package.
 */
export const JX_FRAGMENT = 'the "jx" setting of docusystem.config.json (merged into project.json)';

/** Whether the configuration has a `jx` setting that changes anything (an empty object does not). */
export function hasJxFragment(
  config: { jx?: Record<string, unknown> } | null | undefined,
): boolean {
  return config?.jx !== undefined && Object.keys(config.jx).length > 0;
}

/** One entry of `overrides/.ejected.json`. */
export interface EjectRecord {
  from: string;
  sha256: string;
}

const RECORD_FILE = ".ejected.json";

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Every file of the folders in `OVERRIDE_DIRS` under `root`, relative to it and `/`-separated, sorted.
 * Dotfiles and symbolic links to folders are left out (the build ignores them too); a link to a file is
 * listed by name.
 */
function jxFilesBelow(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string, prefix: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const rel = `${prefix}${entry.name}`;
      if (entry.isDirectory()) visit(join(dir, entry.name), `${rel}/`);
      else if (entry.isFile() || (entry.isSymbolicLink() && isFile(join(dir, entry.name)))) {
        out.push(rel);
      }
    }
  };
  for (const folder of OVERRIDE_DIRS) visit(join(root, folder), `${folder}/`);
  return out.sort();
}

/** The files of the package that can be ejected, as `components/docs-footer.json`; sorted. */
export function ejectableFiles(siteSource: string = packageSiteDir()): string[] {
  return jxFilesBelow(siteSource).filter((rel) => isFile(join(siteSource, ...rel.split("/"))));
}

/** Reads `overrides/.ejected.json`; `{}` when there is none. Throws an Error that says what is wrong. */
function readRecord(file: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return {};
    throw new Error(`cannot read overrides/${RECORD_FILE}: ${(error as Error).message}`, {
      cause: error,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `overrides/${RECORD_FILE} is not valid JSON (${(error as Error).message}): fix it, or delete it and eject the files again`,
      { cause: error },
    );
  }
  if (!isObject(parsed)) {
    throw new Error(
      `overrides/${RECORD_FILE} must be a JSON object that maps file names to {"from", "sha256"}`,
    );
  }
  return parsed;
}

/** Whether `value` is a well-formed record of an ejected file. */
const isRecord = (value: unknown): value is EjectRecord =>
  isObject(value) &&
  typeof value.from === "string" &&
  value.from !== "" &&
  typeof value.sha256 === "string" &&
  /^[0-9a-f]{64}$/.test(value.sha256);

/**
 * Checks that `rel` names a Jx file of the package that can be ejected and returns its parts:
 * `components/<file>`, `layouts/<path>` or `pages/<path>`, `/`-separated, no empty, `.` or `..` part;
 * `components/` is flat because Jx registers only `<root>/components/*.json`.
 */
function ejectParts(rel: string, siteSource: string): string[] {
  const parts = rel.split("/");
  const shape =
    parts.length >= 2 &&
    (OVERRIDE_DIRS as readonly string[]).includes(parts[0] ?? "") &&
    !(parts[0] === "components" && parts.length !== 2) &&
    parts.every((part) => part !== "" && part !== "." && part !== ".." && !/[\\\0]/.test(part));
  const known = ejectableFiles(siteSource);
  if (!shape || !known.includes(rel)) {
    const near = known.filter((file) => file.startsWith(`${parts[0]}/`));
    throw new Error(
      `${JSON.stringify(rel)} is not a file that the installed package ships: name one of ` +
        `${(near.length > 0 ? near : known).join(", ")}`,
    );
  }
  return parts;
}

/**
 * `docusystem eject`: copies the package file `rel` (`components/docs-footer.json`) into
 * `<site>/overrides/` and records where it came from and its SHA-256 in `overrides/.ejected.json`.
 * Returns the absolute path of the new override. Throws when the package ships no such file or when the
 * override exists already (without `force`, which replaces it and refreshes its record).
 * `siteSource` is the package's `site/` folder (tests only).
 */
export function ejectFile(
  siteDir: string,
  rel: string,
  o: { force?: boolean; siteSource?: string } = {},
): { to: string } {
  const siteSource = o.siteSource ?? packageSiteDir();
  const parts = ejectParts(rel, siteSource);
  const from = join(siteSource, ...parts);
  const overrides = join(siteDir, "overrides");
  const to = join(overrides, ...parts);

  let exists = true;
  try {
    lstatSync(to);
  } catch {
    exists = false;
  }
  if (exists && o.force !== true) {
    throw new Error(
      `overrides/${rel} exists already: nothing was changed (use --force to replace it with the package's file)`,
    );
  }

  const record = readRecord(join(overrides, RECORD_FILE));
  // Writing: the folders must be the shell's own, never links that lead somewhere else.
  ensureRealDir(overrides);
  ensureRealDir(join(overrides, parts[0] ?? ""));
  copyFile(from, to);
  record[rel] = { from: version, sha256: sha256(from) } satisfies EjectRecord;
  writeJson(
    join(overrides, RECORD_FILE),
    Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  );
  return { to };
}

/**
 * Drift of the overrides of a site against the installed package (see the table at the top of this
 * file). `siteSource` is the package's `site/` folder (tests only). No overrides, no findings.
 */
export function overrideFindings(siteDir: string, o: { siteSource?: string } = {}): Finding[] {
  const siteSource = o.siteSource ?? packageSiteDir();
  const overrides = join(siteDir, "overrides");
  const findings: Finding[] = [];

  let raw: Record<string, unknown>;
  try {
    raw = readRecord(join(overrides, RECORD_FILE));
  } catch (error) {
    return [{ level: "error", message: (error as Error).message }];
  }
  const record = new Map<string, EjectRecord>();
  for (const [rel, entry] of Object.entries(raw)) {
    if (isRecord(entry)) record.set(rel, entry);
    else {
      findings.push({
        level: "error",
        message: `overrides/${RECORD_FILE}: the entry for ${rel} is not {"from": "<version>", "sha256": "<64 hex digits>"}`,
      });
    }
  }

  for (const rel of jxFilesBelow(overrides)) {
    const shipped = join(siteSource, ...rel.split("/"));
    const entry = record.get(rel);
    const malformed = Object.hasOwn(raw, rel) && entry === undefined;
    if (!isFile(shipped)) {
      if (entry !== undefined) {
        findings.push({
          level: "error",
          message:
            `overrides/${rel} was copied from ${entry.from}, but the installed package (${version}) no ` +
            `longer ships ${rel}: delete the override (or, if it is now a file of your own, its entry in overrides/${RECORD_FILE})`,
        });
      }
    } else if (entry !== undefined) {
      if (entry.sha256 === sha256(shipped)) {
        findings.push({
          level: "ok",
          message: `overrides/${rel} is current with the package's file (copied from ${entry.from})`,
        });
      } else {
        findings.push({
          level: "warning",
          message:
            `overrides/${rel}: copied from ${entry.from}, package file changed (installed: ${version}): ` +
            `diff node_modules/@avunu/docusystem/site/${rel} against it and merge the changes, or delete the override`,
        });
      }
    } else if (!malformed) {
      findings.push({
        level: "warning",
        message:
          `overrides/${rel} replaces a package file but was not made with docusystem eject: nothing tells ` +
          `whether the package's file has changed since (diff it against node_modules/@avunu/docusystem/site/${rel})`,
      });
    }
  }
  return findings;
}
