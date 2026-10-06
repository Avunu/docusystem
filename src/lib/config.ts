// docusystem.config.json: the facts about a project that its documentation site needs (section 4.2 of
// the architecture decision record). The shell repository holds it (`docusystem init` writes it once),
// the CLI validates it, writes the resolved copy into the generated Jx root, and the layouts read that
// copy at build time. This module also finds the site folder and the repository, resolves the default
// branch, and computes every path of a run.
//
// The schema (config.schema.json, exported as `@avunu/docusystem/config.schema.json`) is the editor's
// view of the same contract; `validateConfig` enforces at least everything it does, and
// test/config/schema.test.ts holds the two to each other (the patterns, the limits, the platforms and a
// table of inputs). Every key here is part of the semver surface (7.1): add optional keys freely (a
// minor), never rename or require one without a major.
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isInside } from "./fsutil.js";
import { PLATFORMS } from "./platforms.js";
import type { DocsConfig, Paths } from "./types.js";

export const CONFIG_FILE = "docusystem.config.json";

/** The Markdown folder when the configuration does not name one: `docs/` beside the site folder. */
export const DEFAULT_DOCS = "../docs";

/** The text older tools wrote for a tagline nobody had filled in; it is refused. */
export const PLACEHOLDER_TAGLINE =
  "One sentence that says what this project does and who it is for.";

/** A configuration that is not valid: `problems` holds every one of them, as sentences. */
export class ConfigError extends Error {
  problems: string[];

  constructor(problems: string[]) {
    super(problems.join("\n"));
    this.name = "ConfigError";
    this.problems = problems;
  }
}

// ---- the contract ----

// A slug is a catalog key, so it may have underscores (erpnext_taskview); a domain label may not.
export const SLUG = /^[a-z0-9][a-z0-9_-]*$/;
export const REPO = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/;
export const DOMAIN = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;
// A branch name that is safe to write into a URL: no spaces, quotes, "..", or a leading dash.
export const BRANCH = /^(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9_][\w./-]{0,99}$/;
export const TOKEN_NAME = /^--[a-z][a-z0-9-]*$/;
// A design-token value is plain CSS: nothing that ends the declaration, opens a block or a tag, or
// escapes. validateConfig also refuses a value that loads a resource (TOKEN_LOADS).
export const TOKEN_VALUE = /^[^;{}<>\\]*$/;
const TOKEN_LOADS = /(?:url|src|image-set)\(|@import/i;

// The text keys are shown by components that hand them on as props, and Jx evaluates every string
// that holds `${` as JavaScript (a `license` of "MIT${...}" ran code on every page). The schema says
// the same, with this pattern.
export const NO_EXPRESSION = /^(?![\s\S]*\$\{)/;

export const NAME_MAX = 80;
export const TAGLINE_MAX = 200;
export const LICENSE_MAX = 80;
export const TOKEN_VALUE_MAX = 200;

/** The seven identity keys: written once by `init`, required by every command. */
export const REQUIRED_KEYS = [
  "name",
  "tagline",
  "slug",
  "platform",
  "repo",
  "domain",
  "license",
] as const;

/** The optional keys, in the order of the schema. */
export const OPTIONAL_KEYS = ["branch", "docs", "theme", "images", "jx"] as const;

/** Every key the configuration accepts. */
export const CONFIG_KEYS = ["$schema", ...REQUIRED_KEYS, ...OPTIONAL_KEYS] as const;

/**
 * Names kept free for later minor releases (4.2): each was unneeded by the three pilots. They are
 * rejected today like any unknown key, with a message that says why the name is not usable yet.
 */
export const RESERVED_KEYS = [
  "switcher",
  "footer",
  "logo",
  "ogImage",
  "landing",
  "editLink",
  "lang",
  "nav",
  "updated",
] as const;

// ---- validation ----

type Bag = Record<string, unknown>;

const isObject = (value: unknown): value is Bag =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** What a value is, for "(got ...)": short, and never more than the first 60 characters of a string. */
function got(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "string") {
    const chars = [...value];
    return JSON.stringify(chars.length > 60 ? `${chars.slice(0, 57).join("")}...` : value);
  }
  if (typeof value === "object") return "an object";
  return String(value);
}

/** The length JSON Schema means by `maxLength`: Unicode code points, not UTF-16 units. */
const length = (value: string): number => [...value].length;

/** The edit distance of two short words (insert, delete, substitute). */
function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min(
        (row[j] ?? 0) + 1,
        (next[j - 1] ?? 0) + 1,
        (row[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    row = next;
  }
  return row[b.length] ?? 0;
}

/** The accepted key that `key` is probably a typo of: a different case, or one or two letters off. */
function suggest(key: string): string | undefined {
  const lower = key.toLowerCase();
  const exact = CONFIG_KEYS.find((known) => known.toLowerCase() === lower);
  if (exact !== undefined) return exact;
  const allowed = key.length >= 6 ? 2 : 1;
  let best: { key: string; distance: number } | undefined;
  for (const known of CONFIG_KEYS) {
    if (known === "$schema") continue;
    const d = distance(lower, known.toLowerCase());
    if (d <= allowed && (best === undefined || d < best.distance)) {
      best = { key: known, distance: d };
    }
  }
  return best?.key;
}

/** A text key: present, a string that is not blank, at most `max` characters. Returns it when usable. */
function text(
  raw: Bag,
  key: string,
  max: number | undefined,
  problems: string[],
): string | undefined {
  const value = raw[key];
  if (value === undefined) {
    if ((REQUIRED_KEYS as readonly string[]).includes(key)) problems.push(`"${key}" is required`);
    return undefined;
  }
  if (typeof value !== "string") {
    problems.push(`"${key}" must be a string (got ${got(value)})`);
    return undefined;
  }
  if (value.trim() === "") {
    problems.push(`"${key}" must not be empty`);
    return undefined;
  }
  if (!NO_EXPRESSION.test(value)) {
    problems.push(
      `"${key}" must not contain \${...}: Jx runs it as JavaScript when the site is built (got ${got(value)})`,
    );
    return undefined;
  }
  if (max !== undefined && length(value) > max) {
    problems.push(
      key === "tagline"
        ? `"tagline" should be one sentence of ${max} characters at most (it has ${length(value)})`
        : `"${key}" is too long: ${max} characters at most (it has ${length(value)})`,
    );
    return undefined;
  }
  return value;
}

/** Whether a path names a place that is not "relative to the configuration file". */
const isAbsoluteLike = (path: string): boolean => /^(?:[\\/]|[A-Za-z]:)/.test(path);

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Where `jx` carries a key that a merge would follow to Object.prototype, as `jx.a.b[0].__proto__`. */
function unsafeJxKeys(fragment: Bag): Array<{ key: string; at: string }> {
  const found: Array<{ key: string; at: string }> = [];
  const pending: Array<{ at: string; value: unknown }> = [{ at: "jx", value: fragment }];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const { at, value } = next;
    if (Array.isArray(value)) {
      value.forEach((item, index) => pending.push({ at: `${at}[${index}]`, value: item }));
    } else if (isObject(value)) {
      for (const [key, child] of Object.entries(value)) {
        if (UNSAFE_KEYS.has(key)) found.push({ key, at: `${at}.${key}` });
        else pending.push({ at: `${at}.${key}`, value: child });
      }
    }
  }
  return found.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

function checkTheme(theme: unknown, problems: string[]): void {
  if (!isObject(theme)) {
    problems.push(`"theme" must be an object with "light" and "dark" (got ${got(theme)})`);
    return;
  }
  for (const key of Object.keys(theme)) {
    if (key !== "light" && key !== "dark") {
      problems.push(`"theme.${key}" is not a theme setting: use "theme.light" and "theme.dark"`);
    }
  }
  for (const mode of ["light", "dark"] as const) {
    const tokens = theme[mode];
    if (tokens === undefined) continue;
    if (!isObject(tokens)) {
      problems.push(
        `"theme.${mode}" must be an object of CSS custom properties (got ${got(tokens)})`,
      );
      continue;
    }
    const at = `"theme.${mode}"`;
    for (const [token, value] of Object.entries(tokens)) {
      if (!TOKEN_NAME.test(token)) {
        problems.push(
          `${at}: ${got(token)} is not a custom property name (it must look like --color-action)`,
        );
      } else if (typeof value !== "string") {
        problems.push(`${at}: the value of ${token} must be a string (got ${got(value)})`);
      } else if (length(value) > TOKEN_VALUE_MAX) {
        problems.push(
          `${at}: the value of ${token} is too long: ${TOKEN_VALUE_MAX} characters at most`,
        );
      } else if (!TOKEN_VALUE.test(value)) {
        problems.push(
          `${at}: the value of ${token} is not plain CSS: it may not contain ; { } < > or a backslash`,
        );
      } else if (TOKEN_LOADS.test(value)) {
        problems.push(
          `${at}: the value of ${token} may not load a resource: no url(), src(), image-set() or @import`,
        );
      }
    }
  }
}

/**
 * Every way `raw` is not a valid docusystem.config.json, as sentences; empty means valid. All problems
 * come at once. It enforces everything config.schema.json does, and a little more (a blank text, an
 * absolute `docs`, a design-token value that loads a resource, the placeholder tagline, a `jx` key that
 * reaches Object.prototype). That a theme token exists in the installed package, and that `docs` lies
 * inside the repository, need the package and the file system: `generateProject` and `pathsFor` check
 * them.
 */
export function validateConfig(raw: unknown): string[] {
  if (!isObject(raw)) return [`the configuration must be a JSON object (got ${got(raw)})`];
  const problems: string[] = [];

  for (const key of Object.keys(raw)) {
    if ((CONFIG_KEYS as readonly string[]).includes(key)) continue;
    if ((RESERVED_KEYS as readonly string[]).includes(key)) {
      problems.push(
        `"${key}" is not a docusystem setting yet: the name is reserved for a later release (remove it)`,
      );
      continue;
    }
    const near = suggest(key);
    problems.push(
      `"${key}" is not a docusystem setting${near === undefined ? "" : `; did you mean "${near}"?`}`,
    );
  }

  if (raw.$schema !== undefined && typeof raw.$schema !== "string") {
    problems.push(`"$schema" must be a string (got ${got(raw.$schema)})`);
  }

  text(raw, "name", NAME_MAX, problems);

  const tagline = text(raw, "tagline", TAGLINE_MAX, problems);
  if (tagline === PLACEHOLDER_TAGLINE) {
    problems.push(
      '"tagline" is still the placeholder text: say in one sentence what the project does',
    );
  }

  const slug = text(raw, "slug", undefined, problems);
  if (slug !== undefined && !SLUG.test(slug)) {
    problems.push(
      `"slug" must be lowercase letters, digits, hyphens and underscores, starting with a letter or digit (got ${got(slug)})`,
    );
  }

  const platform = raw.platform;
  if (platform === undefined) problems.push('"platform" is required');
  else if (typeof platform !== "string" || !(PLATFORMS as readonly string[]).includes(platform)) {
    problems.push(`"platform" must be one of ${PLATFORMS.join(", ")} (got ${got(platform)})`);
  }

  const repo = text(raw, "repo", undefined, problems);
  if (repo !== undefined && !REPO.test(repo)) {
    problems.push(`"repo" must look like https://github.com/Avunu/project (got ${got(repo)})`);
  }

  const domain = text(raw, "domain", undefined, problems);
  if (domain !== undefined && !DOMAIN.test(domain)) {
    problems.push(
      `"domain" must be a host name without a scheme, like project.avunu.net (got ${got(domain)})`,
    );
  }

  text(raw, "license", LICENSE_MAX, problems);

  const branch = raw.branch;
  if (branch !== undefined && (typeof branch !== "string" || !BRANCH.test(branch))) {
    problems.push(
      `"branch" must be a plain branch name such as main, develop or 18.0 (got ${got(branch)})`,
    );
  }

  const docs = raw.docs;
  if (docs !== undefined) {
    if (typeof docs !== "string" || docs === "") {
      problems.push(`"docs" must be a folder path relative to ${CONFIG_FILE} (got ${got(docs)})`);
    } else if (isAbsoluteLike(docs)) {
      problems.push(
        `"docs" must be relative to ${CONFIG_FILE}, not an absolute path (got ${got(docs)}): the file is committed and read on other machines`,
      );
    } else if (docs.includes("\0")) {
      problems.push('"docs" must be a folder path (it contains a NUL character)');
    } else if (!NO_EXPRESSION.test(docs)) {
      problems.push(
        `"docs" must not contain \${...}: the folder name reaches the site's links (got ${got(docs)})`,
      );
    }
  }

  if (raw.theme !== undefined) checkTheme(raw.theme, problems);

  const images = raw.images;
  if (images !== undefined && images !== "optimize" && images !== "off") {
    problems.push(`"images" must be "optimize" or "off" (got ${got(images)})`);
  }

  if (raw.jx !== undefined) {
    if (!isObject(raw.jx)) problems.push(`"jx" must be an object (got ${got(raw.jx)})`);
    else {
      for (const { key, at } of unsafeJxKeys(raw.jx)) {
        problems.push(`"jx" may not contain the key "${key}" (found at ${at})`);
      }
    }
  }

  return problems;
}

/**
 * Reads and validates `<siteDir>/docusystem.config.json`; throws a ConfigError that lists every
 * problem, each starting with the file name. The result holds the keys of the file as written (nothing
 * is inferred or defaulted) without `$schema`, which is the editor's and not a setting.
 */
export function readConfig(siteDir: string): DocsConfig {
  const file = join(siteDir, CONFIG_FILE);
  let source: string;
  try {
    source = readFileSync(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new ConfigError([
      code === "ENOENT" || code === "ENOTDIR"
        ? `${file} does not exist: run \`docusystem init\` in the repository, or pass --site <folder>`
        : `${file} cannot be read (${(error as Error).message})`,
    ]);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source.replace(/^﻿/, ""));
  } catch (error) {
    throw new ConfigError([`${CONFIG_FILE} is not valid JSON: ${(error as Error).message}`]);
  }
  const problems = validateConfig(parsed);
  if (problems.length > 0) {
    throw new ConfigError(problems.map((problem) => `${CONFIG_FILE}: ${problem}`));
  }
  const config = { ...(parsed as Bag) };
  delete config.$schema;
  return config as unknown as DocsConfig;
}

// ---- where things are ----

/** Whether `dir` holds a docusystem.config.json. */
function hasConfig(dir: string): boolean {
  try {
    return statSync(join(dir, CONFIG_FILE)).isFile();
  } catch {
    return false;
  }
}

/**
 * The site folder (4.1): `--site <dir>` when given, else the current folder when it has
 * docusystem.config.json, else `./docs-site` when it has. Throws, naming what was searched, when none
 * of them does. The result is absolute.
 */
export function findSiteDir(arg: string | undefined, cwd: string): string {
  if (arg !== undefined) {
    const dir = resolve(cwd, arg);
    if (hasConfig(dir)) return dir;
    let isFolder = false;
    try {
      isFolder = statSync(dir).isDirectory();
    } catch {
      // reported below
    }
    const nested = join(dir, "docs-site");
    throw new Error(
      isFolder
        ? `--site ${arg}: there is no ${CONFIG_FILE} in ${dir}` +
            (hasConfig(nested) ? ` (the site folder is ${nested}: pass that)` : "")
        : `--site ${arg}: ${dir} is not a folder`,
    );
  }
  const here = resolve(cwd);
  const searched = [here, join(here, "docs-site")];
  for (const dir of searched) if (hasConfig(dir)) return dir;
  throw new Error(
    [
      `no ${CONFIG_FILE} found. Looked in:`,
      ...searched.map((dir) => `  ${dir}`),
      "Run `docusystem init` in the repository, or pass --site <folder>.",
    ].join("\n"),
  );
}

/**
 * The repository root: the site folder or its nearest ancestor that contains `.git` (a folder, or the
 * file of a worktree or a submodule), else the parent of the site folder.
 */
export function findRepoRoot(siteDir: string): string {
  const site = resolve(siteDir);
  for (let dir = site; ; dir = dirname(dir)) {
    try {
      statSync(join(dir, ".git"));
      return dir;
    } catch {
      // not here
    }
    if (dirname(dir) === dir) break;
  }
  return dirname(site);
}

/**
 * `origin/HEAD` of the repository at `repoRoot`, without the `origin/`, or null. Git sees only that
 * folder (a folder that is not a repository must not borrow the answer of one above it) and only PATH
 * and HOME of the environment (4.1: nothing else is read).
 */
function originHead(repoRoot: string): string | null {
  const result = spawnSync("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      GIT_CEILING_DIRECTORIES: dirname(resolve(repoRoot)),
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  if (result.status !== 0) return null;
  const name = result.stdout.trim().replace(/^origin\//, "");
  return BRANCH.test(name) ? name : null;
}

/**
 * The default branch of the repository, for "Edit this page" and the GitHub links: config `branch`,
 * else `$DOCUSYSTEM_BRANCH` (when it is a valid branch name; the workflow sets it from the repository's
 * default branch), else `origin/HEAD` as the clone knows it, else `main`.
 */
export function resolveBranch(
  config: Pick<DocsConfig, "branch">,
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (config.branch !== undefined && config.branch !== "") return config.branch;
  const fromEnv = env.DOCUSYSTEM_BRANCH;
  if (fromEnv !== undefined && BRANCH.test(fromEnv)) return fromEnv;
  return originHead(repoRoot) ?? "main";
}

/**
 * Every folder and file of a run (3.2), all absolute. The Markdown folder is `docs` resolved against
 * the site folder (default `../docs`) and must lie inside the repository, and not inside what
 * docusystem generates (`.docusystem/`, `dist/`): files from outside the repository are never
 * published. Throws a ConfigError when it does not.
 */
export function pathsFor(siteDir: string, config: Pick<DocsConfig, "docs">): Paths {
  const site = resolve(siteDir);
  const repoRoot = findRepoRoot(site);
  const docs = config.docs ?? DEFAULT_DOCS;
  const docsDir = resolve(site, docs);
  const work = join(site, ".docusystem");
  const root = join(work, "site");
  const paths: Paths = {
    siteDir: site,
    repoRoot,
    docsDir,
    work,
    root,
    stagedDocs: join(root, ".generated", "docs"),
    navFile: join(root, ".generated", "nav.json"),
    jxDist: join(root, "dist"),
    dist: join(site, "dist"),
    serve: join(work, "serve"),
    manifest: join(work, "manifest.json"),
    jxLog: join(work, "jx.log"),
    lock: join(work, "lock"),
  };

  const refuse = (why: string): never => {
    throw new ConfigError([`${CONFIG_FILE}: "docs" is ${JSON.stringify(docs)}, ${why}`]);
  };
  if (!isInside(repoRoot, docsDir)) {
    refuse(
      `which is ${docsDir}, outside the repository (${repoRoot}): files from outside the repository are never published`,
    );
  }
  if (isInside(work, docsDir) || isInside(paths.dist, docsDir)) {
    refuse(`which is ${docsDir}, inside a folder that docusystem generates`);
  }
  // A folder that is a symbolic link out of the repository is outside it as well.
  let real: string | null = null;
  try {
    real = realpathSync(docsDir);
  } catch {
    // it does not exist (yet): preflight reports that
  }
  if (real !== null && !isInside(realpathSync(repoRoot), real)) {
    refuse(
      `a link to ${real}, outside the repository: files from outside the repository are never published`,
    );
  }
  return paths;
}
