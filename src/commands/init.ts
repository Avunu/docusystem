// `docusystem init`: makes a repository into a thin shell (section 4.1.2 of the architecture decision
// record). It infers what it can from the `origin` remote and the bundled project catalog, writes the
// few files a repository keeps (the configuration, a package.json with one dependency, .gitignore, the
// two caller workflows, the Dependabot entries, a patch to an auto-merge workflow) and never anything
// the package owns. It computes every change first and writes only if nothing is refused, so a
// refusal leaves the repository as it was; running it again changes nothing.
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { isInside } from "../lib/fsutil.js";
import {
  DependabotShapeError,
  dependabotFile,
  ensureDependabotEntries,
} from "../lib/dependabot.js";
import { entryFor, readBundledCatalog } from "../lib/catalog.js";
import { CONFIG_FILE, validateConfig } from "../lib/config.js";
import { checkSlug } from "../lib/preflight.js";
import { gitRootOf, normalizeRemote, originRemote, repoName, runGit } from "../lib/gitremote.js";
import { isAutoMergeWorkflow, patchAutoMerge } from "../lib/automerge.js";
import { name as PACKAGE, version } from "../lib/package-info.js";
import { detectJsonIndent, indentOf, type Indent } from "../lib/indent.js";
import { COMMIT, repinWorkflow, resolvePin, type PinResult } from "../lib/pin.js";
import { PLATFORMS } from "../lib/platforms.js";
import type { CatalogProject, DocsConfig } from "../lib/types.js";
import {
  applyChanges,
  cleanSiteDir,
  docsPathProblem,
  maintainerSteps,
  planChange,
  readScaffold,
  readTextOrNull,
  renderScaffold,
  siteDirProblem,
  unifiedDiff,
  type FileChange,
} from "../lib/workflows.js";
import { EXIT, type CommandContext } from "./types.js";

// ---- deciding the identity keys ----

/** What `decide` needs to settle the seven identity keys (4.1.2). */
export interface InitOptions {
  /** The folder the shell is written into (absolute). */
  siteDir: string;
  /** The repository root (absolute). */
  repoRoot: string;
  name?: string;
  tagline?: string;
  slug?: string;
  platform?: string;
  repo?: string;
  domain?: string;
  license?: string;
  branch?: string;
  docs?: string;
  /** What git may see of the environment (PATH and HOME); default: nothing. */
  env?: NodeJS.ProcessEnv;
}

const IDENTITY = ["name", "tagline", "slug", "platform", "repo", "domain", "license"] as const;
/** The keys of the configuration that init knows how to keep. */
const KNOWN_KEYS = new Set<string>([
  "$schema",
  ...IDENTITY,
  "branch",
  "docs",
  "theme",
  "images",
  "jx",
]);
const SCHEMA = "./node_modules/@avunu/docusystem/config.schema.json";

/** The values of an existing configuration, and the keys init does not know. Null: there is none. */
export function readExistingConfig(
  siteDir: string,
): { values: Record<string, unknown>; unknownKeys: string[] } | null {
  const file = join(siteDir, CONFIG_FILE);
  if (!existsSync(file)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(
      `${CONFIG_FILE} is not valid JSON (${(error as Error).message}): fix it, or delete it and run init again`,
      { cause: error },
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${CONFIG_FILE} is not a JSON object: fix it, or delete it and run init again`);
  }
  const values = parsed as Record<string, unknown>;
  return { values, unknownKeys: Object.keys(values).filter((key) => !KNOWN_KEYS.has(key)) };
}

const textOf = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

/** `Frappe-Nix` as `frappe-nix`: the repository's name as a slug; "" when nothing usable is left. */
const slugFromName = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");

const comparable = (text: string): string => text.toLowerCase().replaceAll("_", "-");

/**
 * Infers the identity keys of a repository: the repository from the `origin` remote, then the catalog
 * entry for it, then slug, name, tagline, platform, license and domain. An option wins over an existing
 * configuration, which wins over inference, so running init again never resets a tagline. A value it
 * cannot infer is an error naming the option. Throws one Error for the first problem.
 */
export function decide(o: InitOptions): { config: DocsConfig; notes: string[] } {
  /** Why each key that was not given has the value it has, shown under "chosen for you". */
  const why: Partial<Record<(typeof IDENTITY)[number], string>> = {};
  const existing = readExistingConfig(o.siteDir);
  const have = existing?.values ?? {};

  // The repository.
  const repo = ((): string => {
    if (o.repo !== undefined) {
      const given = normalizeRemote(o.repo);
      if (given === null) {
        throw new Error("--repo must be a GitHub repository: https://github.com/<owner>/<name>");
      }
      return given;
    }
    const kept = textOf(have.repo);
    if (kept !== undefined) return kept;
    const origin = originRemote(o.repoRoot, o.env);
    if (origin === null) {
      throw new Error(
        "cannot tell which repository this is: there is no `origin` remote (or git is not installed). " +
          "Add one (git remote add origin https://github.com/<owner>/<name>) or pass --repo",
      );
    }
    const inferred = normalizeRemote(origin);
    if (inferred === null) {
      throw new Error(
        "the `origin` remote is not a GitHub repository: pass --repo https://github.com/<owner>/<name>",
      );
    }
    why.repo = "the origin remote";
    return inferred;
  })();

  // The catalog entry that supplies what is not given.
  const projects: CatalogProject[] = readBundledCatalog();
  const { entry: matched, ambiguous } = entryFor(projects, repo);
  const slugGiven = o.slug ?? textOf(have.slug);
  let entry: CatalogProject | undefined;
  if (slugGiven !== undefined) {
    entry = projects.find((project) => project.slug === slugGiven) ?? matched;
    if (!projects.some((project) => project.slug === slugGiven)) {
      const problem = checkSlug(
        slugGiven,
        projects.map((project) => project.slug),
      );
      if (problem.error !== undefined) throw new Error(problem.error);
    }
    // The entry of another slug of the same repository is no source for this site's values.
    if (o.slug !== undefined && entry !== undefined && entry.slug !== o.slug) entry = undefined;
  } else if (matched !== undefined) {
    entry = matched;
  } else if (ambiguous.length > 0) {
    const named = ambiguous.find(
      (project) => comparable(project.slug) === comparable(repoName(repo)),
    );
    if (named === undefined) {
      throw new Error(
        `${repo} has ${ambiguous.length} catalog entries (${ambiguous.map((p) => p.slug).join(", ")}): ` +
          "pass --slug with the one this site is for",
      );
    }
    entry = named;
  }

  // slug
  let slug = slugGiven;
  if (slug === undefined) {
    slug = entry?.slug ?? slugFromName(repoName(repo));
    if (slug === "")
      throw new Error("cannot derive a slug from the repository's name: pass --slug");
    why.slug =
      entry === undefined
        ? `the repository's name; ${repo} is not in the avunu.net catalog yet`
        : `the catalog entry for ${repo}`;
  }

  // name, tagline, license
  const pick = (
    key: "name" | "tagline" | "license",
    option: string | undefined,
    fromCatalog: string | null | undefined,
    flag: string,
    hint: string,
  ): string => {
    const value = option?.trim() || textOf(have[key]);
    if (value !== undefined && value !== "") return value;
    const inferred = textOf(fromCatalog ?? undefined);
    if (inferred === undefined) {
      throw new Error(
        `cannot infer the ${key} (${repo} has no catalog entry that says it): pass ${flag} ${hint}`,
      );
    }
    why[key] = "the catalog's";
    return inferred;
  };
  const name = pick("name", o.name, entry?.title, "--name", '"<display name>"');
  const tagline = pick(
    "tagline",
    o.tagline,
    entry?.summary,
    "--tagline",
    '"<one sentence about the project>"',
  );
  const license = pick(
    "license",
    o.license,
    entry?.license,
    "--license",
    "<SPDX identifier, for example MIT>",
  );

  // platform
  let platform = o.platform?.trim() || textOf(have.platform);
  if (platform === undefined) {
    platform = entry?.platform ?? "general";
    why.platform =
      entry === undefined ? "the default: pass --platform to change it" : "the catalog's";
  }
  if (!(PLATFORMS as readonly string[]).includes(platform)) {
    throw new Error(`--platform must be one of ${PLATFORMS.join(", ")} (got "${platform}")`);
  }

  // domain: a new slug means a new domain
  let domain = o.domain?.trim();
  if (domain === undefined && (o.slug === undefined || o.slug === textOf(have.slug))) {
    domain = textOf(have.domain);
  }
  if (domain === undefined) {
    domain = `${slug.replaceAll("_", "-")}.avunu.net`;
    why.domain = "the slug, with _ written as -";
  }

  const config: DocsConfig = {
    name,
    tagline,
    slug,
    platform: platform as DocsConfig["platform"],
    repo,
    domain,
    license,
  };
  const branch = o.branch?.trim() || textOf(have.branch);
  if (branch !== undefined) config.branch = branch;
  // The Markdown folder is the repository's docs/, whichever folder the site is in.
  let docs = o.docs?.trim() || textOf(have.docs);
  if (docs === undefined) {
    const standard = relative(o.siteDir, join(o.repoRoot, "docs")).split(sep).join("/");
    if (standard !== "../docs") docs = standard;
  }
  if (docs !== undefined && docs !== "../docs") config.docs = docs;
  if (have.theme !== undefined) config.theme = have.theme as NonNullable<DocsConfig["theme"]>;
  if (have.images !== undefined) config.images = have.images as NonNullable<DocsConfig["images"]>;
  if (have.jx !== undefined) config.jx = have.jx as NonNullable<DocsConfig["jx"]>;

  const problems = validateConfig({ ...config });
  if (problems.length > 0) {
    throw new Error(`the values are not valid:\n  - ${problems.join("\n  - ")}`);
  }
  const notes = IDENTITY.flatMap((key) =>
    why[key] === undefined ? [] : [`${key}: ${config[key]}  (${why[key]})`],
  );
  return { config, notes };
}

// ---- the files ----

const WORKFLOW_FILES = ["docs.yml", "docs-publish.yml"] as const;
const WORKFLOW_DIR = ".github/workflows";
const SCRIPTS = { dev: "docusystem dev", build: "docusystem build", check: "docusystem check" };
/** A pin that stands for "any pin": the comparison of a caller with the scaffold ignores which release it is. */
const ANY_SHA = "0".repeat(40);

/** The dependency range written into a new package.json: `^0.1.0` for any 0.1.x. */
const dependencyRange = (): string => {
  const [major = "0", minor = "0"] = version.split(".");
  return `^${Number.parseInt(major, 10)}.${Number.parseInt(minor, 10)}.0`;
};

const lf = (text: string): string => text.replace(/\r\n/g, "\n");

/**
 * The configuration file's text: `$schema` first, then the keys in the order of the schema, indented
 * the way the repository's formatter wants JSON (see ../lib/indent.ts).
 */
function configText(config: DocsConfig, schema: string, indent: Indent): string {
  const ordered: Record<string, unknown> = { $schema: schema };
  for (const key of [...IDENTITY, "branch", "docs", "theme", "images", "jx"] as const) {
    const value = (config as unknown as Record<string, unknown>)[key];
    if (value !== undefined) ordered[key] = value;
  }
  return `${JSON.stringify(ordered, null, indent)}\n`;
}

interface PackagePlan {
  after?: string;
  refusal?: string;
  notes: string[];
}

/** package.json of the site folder: created, or only the dependency and the scripts added (4.1.2). */
function planPackage(
  path: string,
  before: string | null,
  slug: string,
  force: boolean,
  fallbackIndent: Indent,
): PackagePlan {
  const notes: string[] = [];
  const fresh = {
    name: `${slug.replaceAll("_", "-")}-docs`,
    private: true,
    type: "module",
    scripts: { ...SCRIPTS },
    dependencies: { [PACKAGE]: dependencyRange() },
  };
  if (before === null) return { after: `${JSON.stringify(fresh, null, fallbackIndent)}\n`, notes };

  let pkg: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(before);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      throw new Error("not an object");
    pkg = parsed as Record<string, unknown>;
  } catch (error) {
    return {
      refusal: `${path} is not valid JSON (${(error as Error).message}): fix it first`,
      notes,
    };
  }
  const record = (value: unknown): Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const scripts = record(pkg.scripts);
  const sections = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
  const jxDeps = sections.flatMap((section) =>
    Object.keys(record(pkg[section])).filter((dependency) => dependency.startsWith("@jxsuite/")),
  );
  const reasons = [
    ...(scripts.postinstall === undefined ? [] : ["a postinstall script"]),
    ...(jxDeps.length === 0 ? [] : [`a dependency on ${jxDeps.join(", ")}`]),
  ];
  const indent = indentOf(before) ?? fallbackIndent;
  const finish = (next: Record<string, unknown>): string =>
    `${JSON.stringify(next, null, indent)}\n`;

  if (reasons.length > 0) {
    if (!force) {
      return {
        refusal:
          `${path} has ${reasons.join(" and ")}, which means it is a copy of the starter: ` +
          `init will not change it. Run init with --force to rewrite its dependencies to the single package ${PACKAGE} ` +
          "(and its scripts to the three of the shell), or remove the starter's files first",
        notes,
      };
    }
    const devDependencies = Object.fromEntries(
      Object.entries(record(pkg.devDependencies)).filter(
        ([dependency]) => !dependency.startsWith("@jxsuite/"),
      ),
    );
    const next: Record<string, unknown> = {
      ...pkg,
      scripts: { ...SCRIPTS },
      dependencies: { [PACKAGE]: dependencyRange() },
    };
    if (Object.keys(devDependencies).length === 0) delete next.devDependencies;
    else next.devDependencies = devDependencies;
    delete next.optionalDependencies;
    delete next.peerDependencies;
    notes.push("rewrote the starter's dependencies and scripts");
    return { after: finish(next), notes };
  }

  let changed = false;
  const next: Record<string, unknown> = { ...pkg };
  const hasPackage = ["dependencies", "devDependencies"].some(
    (section) => PACKAGE in record(pkg[section]),
  );
  if (!hasPackage) {
    next.dependencies = { ...record(pkg.dependencies), [PACKAGE]: dependencyRange() };
    changed = true;
  }
  const nextScripts: Record<string, unknown> = { ...scripts };
  for (const [script, command] of Object.entries(SCRIPTS)) {
    if (scripts[script] === undefined) {
      nextScripts[script] = command;
      changed = true;
    } else if (scripts[script] !== command) {
      notes.push(`kept your "${script}" script (the shell's is "${command}")`);
    }
  }
  if (changed) next.scripts = nextScripts;
  return changed ? { after: finish(next), notes } : { after: before, notes };
}

/** `.gitignore` with the lines of the scaffold that it lacks appended. */
function gitignoreText(before: string | null): string {
  const scaffold = readScaffold("gitignore");
  if (before === null) return scaffold;
  const wanted = scaffold.split("\n").filter((line) => line !== "");
  const have = new Set(
    before
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#") && !line.startsWith("!"))
      .map((line) => line.replace(/^\//, "").replace(/\/$/, "")),
  );
  const missing = wanted.filter((line) => !have.has(line.replace(/\/$/, "")));
  if (missing.length === 0) return before;
  const base = before === "" || before.endsWith("\n") ? before : `${before}\n`;
  return `${base}${missing.join("\n")}\n`;
}

/** Whether `docsDir` holds a home page (README.md or index.md, in any case; a case-insensitive file system does not tell them apart). */
function hasHome(docsDir: string): boolean {
  if (!existsSync(docsDir)) return false;
  return readdirSync(docsDir).some((file) =>
    ["readme.md", "index.md"].includes(file.toLowerCase()),
  );
}

/** The README at the repository root, or null (a link is not copied: it may point anywhere). */
function findReadme(repoRoot: string): string | null {
  const names = readdirSync(repoRoot)
    .filter((file) => file.toLowerCase() === "readme.md")
    .sort((a, b) => (a === "README.md" ? -1 : b === "README.md" ? 1 : a < b ? -1 : 1));
  for (const file of names) {
    if (lstatSync(join(repoRoot, file)).isFile()) return join(repoRoot, file);
  }
  return null;
}

// ---- the command ----

/** What `run` needs from outside; tests replace it so that no network is used. */
export interface InitDeps {
  /** The commit of the tag of the installed version. */
  resolvePin?: (version: string) => PinResult;
}

interface Place {
  repoRoot: string;
  siteDir: string;
  /** `docs-site`: relative to the repository root, `/`-separated. */
  siteRel: string;
}

/** Where to write: the repository root's site folder, or the site folder itself when run inside it. */
function locate(ctx: CommandContext): Place | string {
  const repoRoot = gitRootOf(ctx.cwd);
  if (repoRoot === null) {
    return `${ctx.cwd} is not inside a git repository (no .git above it): run init in a clone, at its root`;
  }
  let wanted = "docs-site";
  if (ctx.options.siteDir !== undefined) {
    const cleaned = cleanSiteDir(ctx.options.siteDir);
    if (cleaned === null)
      return "--site-dir needs a folder name relative to the repository root, for example docs-site";
    wanted = cleaned;
  }
  const problem = siteDirProblem(wanted);
  if (problem !== null) return problem;
  const there = join(repoRoot, wanted);
  let cwd: string;
  try {
    cwd = realpathSync(resolve(ctx.cwd));
  } catch {
    cwd = resolve(ctx.cwd);
  }
  const atRoot = cwd === repoRoot;
  const inSite =
    cwd === there || (ctx.options.siteDir === undefined && existsSync(join(cwd, CONFIG_FILE)));
  let siteDir: string;
  if (atRoot) siteDir = there;
  else if (inSite) siteDir = cwd;
  else {
    return (
      `run it at the repository root (${repoRoot}) or inside the site folder (${there}), not in ${ctx.cwd}: ` +
      `cd to one of them, or give the site folder with --site-dir`
    );
  }
  const siteRel = relative(repoRoot, siteDir).split(sep).join("/");
  const again = siteDirProblem(siteRel);
  if (again !== null) return again;
  return { repoRoot, siteDir, siteRel };
}

export async function run(ctx: CommandContext): Promise<number> {
  return runInit(ctx, {});
}

/** `run` with its outside world injectable. */
export async function runInit(ctx: CommandContext, deps: InitDeps): Promise<number> {
  const { options } = ctx;
  const fail = (message: string): number => {
    ctx.stderr(`docusystem: init: ${message}`);
    return EXIT.problems;
  };

  if (runGit(["--version"], { env: ctx.env }).missing) {
    return fail(
      "git is not installed or not on PATH: init needs it to read the origin remote and to find the release commit",
    );
  }
  const place = locate(ctx);
  if (typeof place === "string") return fail(place);
  const { repoRoot, siteDir, siteRel } = place;
  const force = options.force === true;
  const dry = options.dryRun === true;
  const siteFile = (name: string): string => `${siteRel}/${name}`;

  let decision: { config: DocsConfig; notes: string[] };
  let existing: ReturnType<typeof readExistingConfig>;
  try {
    existing = readExistingConfig(siteDir);
    decision = decide({
      siteDir,
      repoRoot,
      ...(options.name === undefined ? {} : { name: options.name }),
      ...(options.tagline === undefined ? {} : { tagline: options.tagline }),
      ...(options.slug === undefined ? {} : { slug: options.slug }),
      ...(options.platform === undefined ? {} : { platform: options.platform }),
      ...(options.repo === undefined ? {} : { repo: options.repo }),
      ...(options.domain === undefined ? {} : { domain: options.domain }),
      ...(options.license === undefined ? {} : { license: options.license }),
      ...(options.branch === undefined ? {} : { branch: options.branch }),
      ...(options.docs === undefined ? {} : { docs: options.docs }),
      env: ctx.env,
    });
  } catch (error) {
    return fail((error as Error).message);
  }
  const { config, notes: chosen } = decision;

  // The Markdown folder must be inside the repository (4.1.1) and usable in a path filter.
  const docsDir = resolve(siteDir, config.docs ?? "../docs");
  if (!isInside(repoRoot, docsDir)) {
    return fail(
      `the docs folder ${config.docs ?? "../docs"} is outside the repository: files from outside the repository are never published`,
    );
  }
  const docsRel = relative(repoRoot, docsDir).split(sep).join("/");
  const docsProblem = docsPathProblem(docsRel);
  if (docsProblem !== null) return fail(docsProblem);

  const refusals: string[] = [];
  const byHand: string[] = [];
  const heads: string[] = [];
  const changes: FileChange[] = [];
  const read = (rel: string): string | null => readTextOrNull(join(repoRoot, ...rel.split("/")));

  try {
    // 1. the configuration
    if (existing !== null && existing.unknownKeys.length > 0 && !force) {
      refusals.push(
        `${siteFile(CONFIG_FILE)} has keys that init does not know (${existing.unknownKeys.join(", ")}); ` +
          "run `docusystem doctor` to see what is wrong, or use --force to drop them",
      );
    }
    // New JSON files are indented the way the repository's formatter wants JSON, so that its own
    // format check passes on the adoption pull request; an existing file keeps its indentation.
    const indent = detectJsonIndent(repoRoot);
    const configBefore = read(siteFile(CONFIG_FILE));
    changes.push(
      planChange(
        siteFile(CONFIG_FILE),
        configBefore,
        configText(
          config,
          typeof existing?.values.$schema === "string" ? existing.values.$schema : SCHEMA,
          configBefore === null ? indent : (indentOf(configBefore) ?? indent),
        ),
      ),
    );

    // 2. package.json and .gitignore
    const pkg = planPackage(
      siteFile("package.json"),
      read(siteFile("package.json")),
      config.slug,
      force,
      indent,
    );
    if (pkg.refusal !== undefined) refusals.push(pkg.refusal);
    else if (pkg.after !== undefined) {
      changes.push(
        planChange(
          siteFile("package.json"),
          read(siteFile("package.json")),
          pkg.after,
          pkg.notes.join("; ") || undefined,
        ),
      );
    }
    changes.push(
      planChange(
        siteFile(".gitignore"),
        read(siteFile(".gitignore")),
        gitignoreText(read(siteFile(".gitignore"))),
      ),
    );

    // 3. the documentation home
    if (!hasHome(docsDir)) {
      const where = docsRel === "" ? "." : docsRel;
      const readme = options.fromReadme === true ? findReadme(repoRoot) : null;
      if (readme !== null) {
        const target = `${docsRel === "" ? "" : `${docsRel}/`}README.md`;
        changes.push(
          planChange(
            target,
            null,
            readFileSync(readme, "utf8"),
            `a copy of ${relative(repoRoot, readme)}`,
          ),
        );
      } else {
        heads.push(
          options.fromReadme === true
            ? `${where}/ has no README.md or index.md and the repository has no README to copy: write the documentation home page`
            : `${where}/ has no README.md or index.md: write the documentation home page, or run init again with --from-readme`,
        );
      }
    }

    // 4. the caller workflows, pinned to the commit of the installed version's tag
    if (options.noWorkflow !== true) {
      const rendered = (file: (typeof WORKFLOW_FILES)[number], sha: string, ver: string): string =>
        renderScaffold(file, { docs: docsRel, site: siteRel, sha, version: ver });
      const wanted = WORKFLOW_FILES.map((file) => {
        const path = `${WORKFLOW_DIR}/${file}`;
        const before = read(path);
        const same =
          before !== null &&
          lf(repinWorkflow(before, ANY_SHA, "0.0.0") ?? before) ===
            lf(rendered(file, ANY_SHA, "0.0.0"));
        return { file, path, before, same };
      });
      const writing = wanted.filter((w) => w.before === null || (!w.same && force));
      for (const w of wanted) {
        if (w.before !== null && !w.same && !force) {
          refusals.push(
            `${w.path} exists and is not the caller that init writes (a copy of the starter's workflow?): ` +
              "init will not overwrite it. Use --force to replace it, or --no-workflow to leave the workflows alone",
          );
        }
      }
      if (writing.length > 0 && refusals.length === 0) {
        let sha = options.workflowSha?.toLowerCase();
        if (sha !== undefined && !COMMIT.test(sha)) {
          return fail(
            `--workflow-sha must be a full 40-character commit id (got "${options.workflowSha}")`,
          );
        }
        if (sha === undefined) {
          const found = (deps.resolvePin ?? ((v: string) => resolvePin(v, { env: ctx.env })))(
            version,
          );
          if (found.sha === null) {
            return fail(
              `could not find the commit of the tag v${version} to pin the workflows to: ${found.reason ?? "unknown"}. ` +
                "Nothing was written. Pass the commit with --workflow-sha <40-character commit>, " +
                "or use --no-workflow and add the workflows yourself",
            );
          }
          sha = found.sha;
        }
        for (const w of writing) {
          changes.push(planChange(w.path, w.before, rendered(w.file, sha, version)));
        }
      }
      for (const w of wanted) {
        if (w.before !== null && w.same)
          changes.push(
            planChange(w.path, w.before, w.before, "already the caller of the shared workflow"),
          );
      }
    }

    // 5. Dependabot
    if (options.noDependabot !== true) {
      const path = dependabotFile(repoRoot);
      const before = read(path);
      try {
        const next = ensureDependabotEntries(before, {
          site: siteRel,
          actions: options.noWorkflow !== true,
        });
        changes.push(
          planChange(path, before, next.text, next.changes.join("; ") || "the entries are there"),
        );
      } catch (error) {
        if (!(error instanceof DependabotShapeError)) throw error;
        byHand.push(
          `${path} ${error.message}; add this to its \`updates:\` list by hand:\n${error.snippet.trimEnd()}`,
        );
      }
    }

    // 6. the auto-merge workflow
    if (options.noPatchAutomerge !== true) {
      const dir = join(repoRoot, ...WORKFLOW_DIR.split("/"));
      const files = existsSync(dir)
        ? readdirSync(dir)
            .filter((file) => /\.ya?ml$/.test(file))
            .sort()
        : [];
      for (const file of files) {
        const path = `${WORKFLOW_DIR}/${file}`;
        const before = read(path);
        if (before === null || !isAutoMergeWorkflow(before)) continue;
        const patched = patchAutoMerge(before, siteRel);
        if (patched.note !== undefined) byHand.push(`${path}: ${patched.note}`);
        else if (patched.changed) {
          changes.push(
            planChange(path, before, patched.text, `${siteRel} updates now wait for a person`),
          );
        }
      }
    }
  } catch (error) {
    return fail((error as Error).message);
  }

  if (refusals.length > 0) {
    for (const refusal of refusals) ctx.stderr(`docusystem: init: refused: ${refusal}`);
    ctx.stderr("docusystem: init: nothing was written");
    return EXIT.problems;
  }

  const todo = changes.filter((change) => change.action !== "unchanged");
  if (!dry) {
    try {
      applyChanges(repoRoot, todo);
    } catch (error) {
      return fail(`${(error as Error).message}. Nothing was written`);
    }
  }

  // ---- the report ----
  const verb = (change: FileChange): string =>
    change.action === "unchanged"
      ? "unchanged"
      : `${dry ? "would " : ""}${change.action === "create" ? "create" : "update"}`;
  const width = Math.max(...changes.map((change) => verb(change).length));
  ctx.stdout(
    todo.length === 0
      ? "init: nothing to do: the shell is in place"
      : dry
        ? `init (dry run): would write ${todo.length} file${todo.length === 1 ? "" : "s"}; nothing was written`
        : `init: wrote ${todo.length} file${todo.length === 1 ? "" : "s"}`,
  );
  for (const change of changes) {
    ctx.stdout(
      `  ${verb(change).padEnd(width)}  ${change.path}${change.note === undefined ? "" : `  (${change.note})`}`,
    );
  }
  if (dry) {
    for (const change of todo) {
      ctx.stdout("");
      for (const line of unifiedDiff(change.path, change.before, change.after)) ctx.stdout(line);
    }
  }
  if (chosen.length > 0) {
    ctx.stdout("");
    ctx.stdout("Chosen for you (pass the option to change it):");
    for (const note of chosen) ctx.stdout(`  ${note}`);
  }
  if (heads.length > 0 || byHand.length > 0) {
    ctx.stdout("");
    ctx.stdout("Not done, for you to do by hand:");
    for (const note of [...heads, ...byHand]) {
      const [first = "", ...rest] = note.split("\n");
      ctx.stdout(`  ${first}`);
      for (const line of rest) ctx.stdout(`    ${line}`);
    }
  }
  ctx.stdout("");
  ctx.stdout("A maintainer still has to:");
  for (const step of maintainerSteps(config)) ctx.stdout(`  - ${step}`);
  ctx.stdout("");
  ctx.stdout(`Next: cd ${siteRel} && npm install && npm run check`);
  return EXIT.ok;
}
