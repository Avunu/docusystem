// The project catalog: https://avunu.net/projects.json, contract version 1.
//
// The package ships a snapshot of it (site/data/projects.snapshot.json). A build uses the bundled
// snapshot, so its output never depends on avunu.net being up and a malformed catalog never reaches the
// project switcher; `build --refresh-catalog` asks the live catalog instead and accepts the answer only
// when it conforms to the contract below. The browser swaps in the live catalog itself when idle
// (components/project-switcher.json). `scripts/sync-catalog.mjs` refreshes the bundled snapshot.
//
// The contract (version 1): { version, generated, site, projects: [{ slug, title, platform, summary,
// repo, page, docs, license, status, suite }] }; platform is one of frappe, odoo, wordpress, nixos,
// general; docs is null until a project has its own docs site; license and suite may be null.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { packageRoot } from "./package-info.js";
import { PLATFORMS } from "./platforms.js";
import type { Catalog, CatalogProject } from "./types.js";

export const CATALOG_URL = "https://avunu.net/projects.json";

/** How long `syncCatalog` waits for the answer, headers and body together. */
export const DEFAULT_TIMEOUT_MS = 5000;

/** The most a catalog may weigh (the real one is about 13 KB for 26 projects). */
export const MAX_CATALOG_BYTES = 2 * 1024 * 1024;

/** An absolute https URL with a host and no white space: what a link of the catalog may be. */
function isHttps(value: unknown): value is string {
  if (typeof value !== "string" || /\s/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname !== "";
  } catch {
    return false;
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Every way `doc` differs from the version 1 contract, as sentences; empty means it conforms. */
export function validateCatalog(doc: unknown): string[] {
  if (!isObject(doc)) return ["the document is not a JSON object"];
  const problems: string[] = [];
  if (doc.version !== 1) problems.push(`"version" must be 1 (got ${JSON.stringify(doc.version)})`);
  if (typeof doc.generated !== "string" || doc.generated === "") {
    problems.push('"generated" must be a timestamp string');
  }
  if (!isHttps(doc.site)) problems.push('"site" must be an https URL');
  if (!Array.isArray(doc.projects)) return [...problems, '"projects" must be an array'];
  if (doc.projects.length === 0) problems.push('"projects" is empty');
  const seen = new Set<string>();
  doc.projects.forEach((entry: unknown, index: number) => {
    const at = `projects[${index}]`;
    if (!isObject(entry)) {
      problems.push(`${at} is not an object`);
      return;
    }
    const name = typeof entry.slug === "string" && entry.slug !== "" ? entry.slug : at;
    for (const key of ["slug", "title", "summary"] as const) {
      if (typeof entry[key] !== "string" || entry[key] === "") {
        problems.push(`${name}: "${key}" must be a non-empty string`);
      }
    }
    if (typeof entry.slug === "string") {
      if (seen.has(entry.slug)) problems.push(`${name}: duplicate slug`);
      seen.add(entry.slug);
    }
    if (
      typeof entry.platform !== "string" ||
      !(PLATFORMS as readonly string[]).includes(entry.platform)
    ) {
      problems.push(`${name}: "platform" must be one of ${PLATFORMS.join(", ")}`);
    }
    if (!isHttps(entry.repo)) problems.push(`${name}: "repo" must be an https URL`);
    if (!isHttps(entry.page)) problems.push(`${name}: "page" must be an https URL`);
    if (entry.docs !== null && !isHttps(entry.docs)) {
      problems.push(`${name}: "docs" must be an https URL or null`);
    }
    if (entry.license !== null && typeof entry.license !== "string") {
      problems.push(`${name}: "license" must be a string or null`);
    }
    if (typeof entry.status !== "string") problems.push(`${name}: "status" must be a string`);
    if (entry.suite !== null && typeof entry.suite !== "string") {
      problems.push(`${name}: "suite" must be a string or null`);
    }
  });
  return problems;
}

/** The path of the catalog bundled in the package. */
export function bundledCatalogFile(): string {
  return join(packageRoot, "site", "data", "projects.snapshot.json");
}

/**
 * The whole bundled catalog document; throws when it is missing or does not conform, which means a
 * broken installation. `file` is the bundled one; a test passes another.
 */
export function readBundledCatalogDocument(file: string = bundledCatalogFile()): Catalog {
  const broken = (what: string): Error =>
    new Error(
      `the project catalog bundled with docusystem (${file}) ${what}: reinstall @avunu/docusystem`,
    );
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw broken(`cannot be read (${(error as Error).message})`);
  }
  const problems = validateCatalog(doc);
  if (problems.length > 0) throw broken(`does not conform to the contract (${problems[0]})`);
  return doc as Catalog;
}

/** The catalog bundled in the package (`site/data/projects.snapshot.json`); throws when it is broken. */
export function readBundledCatalog(): CatalogProject[] {
  return readBundledCatalogDocument().projects;
}

/** The outcome of `syncCatalog`, for the caller that has to tell "not published yet" from "broken". */
export type SyncOutcome =
  /** `out` now holds the live catalog, which differed from what was there. */
  | "written"
  /** `out` already held exactly the live catalog. */
  | "unchanged"
  /** The address answered 404 or 410: the catalog is not published (yet). */
  | "not-live"
  /** The address answered, but not with a version 1 catalog. */
  | "invalid"
  /** No answer: network trouble, a timeout, an error status, an answer that is too large. */
  | "failed";

/** What `syncCatalog` reports. `outcome` is an addition to the frozen `{ ok, message }`. */
export interface SyncResult {
  ok: boolean;
  message: string;
  outcome: SyncOutcome;
}

/** Why a fetch failed, as a clause: "timed out after 5000 ms", "connection refused". */
function reasonOf(error: unknown, timeoutMs: number): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      return `timed out after ${timeoutMs} ms`;
    }
    const cause = (error as { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message !== "") return cause.message;
    return error.message;
  }
  return String(error);
}

/** The body of `response` as text, or null when it is larger than `max` bytes. */
async function readLimited(response: Response, max: number): Promise<string | null> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (response.body !== null) {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.byteLength;
      if (size > max) return null;
      chunks.push(chunk);
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Writes `contents` to `file` so that a reader sees the old file or the new one, never half of it. */
function writeAtomically(file: string, contents: string): void {
  mkdirSync(dirname(file), { recursive: true });
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
 * Fetches the live catalog and writes it to `out` only if it is a version 1 catalog: any other answer,
 * and every kind of network trouble (a timeout included), leaves `out` as it was and says why in
 * `message` (the reason alone: the caller says what it falls back to). Never throws on those.
 *
 * The address defaults to CATALOG_URL and the timeout, which covers headers and body, to 5 seconds. An
 * answer larger than 2 MiB, and a redirect from https to something else, are refused.
 */
export async function syncCatalog(o: {
  url?: string;
  out: string;
  timeoutMs?: number;
}): Promise<SyncResult> {
  const url = o.url ?? CATALOG_URL;
  const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fail = (outcome: SyncOutcome, message: string): SyncResult => ({
    ok: false,
    outcome,
    message,
  });

  let body: string | null;
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      const gone = response.status === 404 || response.status === 410;
      return fail(
        gone ? "not-live" : "failed",
        `${url} answered ${response.status}${gone ? ": no catalog is published there (yet)" : ""}`,
      );
    }
    if (new URL(url).protocol === "https:" && !response.url.startsWith("https:")) {
      return fail("failed", `${url} was redirected to ${response.url}, which is not https`);
    }
    body = await readLimited(response, MAX_CATALOG_BYTES);
  } catch (error) {
    return fail("failed", `could not fetch ${url} (${reasonOf(error, timeoutMs)})`);
  }
  if (body === null) {
    return fail("failed", `${url} answered more than ${MAX_CATALOG_BYTES} bytes`);
  }

  let doc: unknown;
  try {
    doc = JSON.parse(body);
  } catch {
    return fail("invalid", `${url} did not return JSON`);
  }
  const problems = validateCatalog(doc);
  if (problems.length > 0) {
    return fail(
      "invalid",
      `${url} does not match the catalog contract:\n  - ${problems.slice(0, 8).join("\n  - ")}`,
    );
  }

  const catalog = doc as Catalog;
  const next = `${JSON.stringify(catalog, null, 2)}\n`;
  let previous: string | null = null;
  try {
    previous = readFileSync(o.out, "utf8");
  } catch {
    // there is none yet
  }
  if (previous === next) {
    return {
      ok: true,
      outcome: "unchanged",
      message: `already current (${catalog.projects.length} projects)`,
    };
  }
  try {
    writeAtomically(o.out, next);
  } catch (error) {
    return fail("failed", `could not write ${o.out} (${(error as Error).message})`);
  }
  return {
    ok: true,
    outcome: "written",
    message: `wrote ${catalog.projects.length} projects (generated ${catalog.generated})`,
  };
}

/**
 * What differs between two catalogs, one line per project that was added, removed or changed (and one
 * for the document's own fields), ignoring `generated`: a catalog that is regenerated without a change
 * is the same catalog. Empty means they are the same.
 */
export function catalogChanges(before: Catalog, after: Catalog): string[] {
  const changes: string[] = [];
  const index = (catalog: Catalog): Map<string, CatalogProject> =>
    new Map(catalog.projects.map((project) => [project.slug, project]));
  const was = index(before);
  const is = index(after);
  for (const [slug, project] of is) {
    const old = was.get(slug);
    if (old === undefined) {
      changes.push(`added ${slug} (${project.platform})`);
      continue;
    }
    const keys = new Set([...Object.keys(project), ...Object.keys(old)]) as Set<
      keyof CatalogProject
    >;
    const fields = [...keys].filter(
      (key) => JSON.stringify(project[key]) !== JSON.stringify(old[key]),
    );
    if (fields.length > 0) changes.push(`changed ${slug}: ${fields.sort().join(", ")}`);
  }
  for (const slug of was.keys()) if (!is.has(slug)) changes.push(`removed ${slug}`);
  if (before.site !== after.site) changes.push(`changed the site: ${before.site} to ${after.site}`);
  return changes;
}

// ---- lookups ----

/** `https://github.com/Avunu/X/`, `https://github.com/avunu/x.git` and `Avunu/x` name the same repository. */
function repoKey(repo: string): string {
  return repo
    .trim()
    .replace(/^https?:\/\/(?:www\.)?github\.com\//i, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

/** Whether two repository addresses name the same repository (case, `.git` and a trailing slash do not matter). */
export const sameRepo = (a: string, b: string): boolean => repoKey(a) === repoKey(b);

/** The last part of a GitHub address: `erpnext_taskview` for https://github.com/Avunu/erpnext_taskview. */
export const repoName = (repo: string): string => repoKey(repo).split("/").pop() ?? "";

const flat = (slug: string): string => slug.toLowerCase().replaceAll("_", "-");

/**
 * The catalog entry of a repository. A repository can have several entries (avunu-odoo-addons has
 * five): the one named like the repository is the site's project; with none of that name the answer is
 * ambiguous, and the entries that match are listed so that the caller can ask for `--slug`. With no
 * entry at all both are empty. `repo` is an address (`https://github.com/Avunu/x`) or `Avunu/x`.
 */
export function entryFor(
  projects: CatalogProject[],
  repo: string,
): { entry?: CatalogProject; ambiguous: CatalogProject[] } {
  const entries = projects.filter((project) => sameRepo(project.repo, repo));
  const [only] = entries;
  if (entries.length === 1 && only !== undefined) return { entry: only, ambiguous: [] };
  const name = repoName(repo);
  const named =
    entries.find((project) => project.slug.toLowerCase() === name) ??
    (entries.filter((project) => flat(project.slug) === flat(name)).length === 1
      ? entries.find((project) => flat(project.slug) === flat(name))
      : undefined);
  if (named !== undefined) return { entry: named, ambiguous: [] };
  return { ambiguous: entries };
}
