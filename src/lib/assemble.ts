// Assembles the Jx project root `<site>/.docusystem/site/` (step 4 of the pipeline, 5.1 and 3.2 of the
// architecture decision record): a plain directory of real files that `jx build <root>` reads exactly as
// it would read a hand-written site. Jx reads `components/`, `layouts/`, `pages/`, `public/` and the
// `$layout` chain only from the project root, and 5.0.0 has no way to take them from a package, so the
// root is where the package's files, the shell's overrides, the generated files and (later steps) the
// project's Markdown meet.
//
//   <site>/.docusystem/
//     manifest.json                 where every file of the root came from (written last)
//     site/                         the root, recreated empty by every run
//       project.json                generated: site/project.base.json + identity + theme + `jx` (project.ts)
//       docusystem.config.json      generated: the resolved configuration the layouts read
//       components/ layouts/ pages/ package copies, then <site>/overrides/ on top
//       public/                     package public/, then <site>/public/, then CNAME (= domain)
//       data/projects.snapshot.json the bundled catalog (a live copy only with --refresh-catalog)
//       node_modules/@jxsuite/*     links to the Jx packages this version depends on (jx.ts)
//
// Precedence, lowest to highest: package, overrides, generated. Everything is a real copy, never a link,
// so the root behaves the same on every file system, installer and watcher; the only links are the four
// to the Jx packages.
//
// Output contract. `Assembly.warnings` and `Assembly.errors` are complete lines that carry their own
// stage prefix (`assemble:`, `overrides:` or `catalog:`): print them as they are. `shadowed`, `added` and
// `skipped` are data (paths relative to the site folder for `skipped`): the caller words them.
import { mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { CATALOG_URL, syncCatalog } from "./catalog.js";
import { copyFile, ensureRealDir, removeInside, walkFiles, writeJson } from "./fsutil.js";
import { linkJxPackages } from "./jx.js";
import { hasJxFragment, OVERRIDE_DIRS } from "./overrides.js";
import { name, version } from "./package-info.js";
import { generateProject, packageSiteDir, readBaseProject } from "./project.js";
import type { DocsConfig, Manifest, Origin, Paths, SkippedPath, WalkResult } from "./types.js";

export interface AssembleArgs {
  paths: Paths;
  config: DocsConfig;
  branch: string;
  strict: boolean;
  refreshCatalog?: boolean;
  catalogUrl?: string;
  env?: NodeJS.ProcessEnv;
}

export interface Assembly {
  /** What was written to `<work>/manifest.json`. */
  manifest: Manifest;
  /** Files of the package that an override (or a file of `<site>/public/`) replaced, e.g. `components/docs-footer.json`. */
  shadowed: string[];
  /** Files of `<site>/overrides/` that replace nothing: a page, layout or component of the site's own. */
  added: string[];
  /** Symbolic links of `overrides/` and `public/` that were not published, relative to the site folder (`public/logo.svg`). */
  skipped: SkippedPath[];
  /** Lines worth printing that do not fail the build, each with its stage prefix. */
  warnings: string[];
  /** Problems the site cannot be built with (theme, overrides, a supplied CNAME), each with its stage prefix. */
  errors: string[];
}

export interface AssembleOptions {
  /** The folder to read the package's Jx files from instead of the package's own `site/` (tests). */
  siteSource?: string;
}

/** How long `--refresh-catalog` waits for avunu.net. */
const CATALOG_TIMEOUT_MS = 5_000;

/** Every file below `dir` (links are read through: the package is trusted), `/`-separated and sorted. */
function packageFilesBelow(dir: string): string[] {
  const out: string[] = [];
  const visit = (folder: string, prefix: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      const rel = `${prefix}${entry.name}`;
      const stat = entry.isSymbolicLink() ? statSync(path) : entry;
      if (stat.isDirectory()) visit(path, `${rel}/`);
      else if (stat.isFile()) out.push(rel);
    }
  };
  visit(dir, "");
  return out.sort();
}

/** `/`-separated, sorted by code unit (the same order on every machine). */
const byPath = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const runtimeName = (): string =>
  process.versions.bun === undefined
    ? `node ${process.versions.node}`
    : `bun ${process.versions.bun}`;

/** Writes a text file (a link at the path is replaced, never written through). */
function writeText(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  rmSync(file, { force: true });
  writeFileSync(file, text);
}

/**
 * Steps 3 to 4 of the pipeline: starts the root from nothing (`<work>/site` and `<work>/manifest.json`
 * are deleted; the lock file beside them is not), copies the package's `site/` (except
 * `project.base.json` and `data/`), lays `<site>/overrides/{components,layouts,pages}/**` and
 * `<site>/public/**` over it, generates `project.json`, `docusystem.config.json` and `public/CNAME`,
 * puts the catalog in `data/`, links the Jx packages and writes `manifest.json`.
 *
 * The lock (step 3) is the caller's: `acquireLock` first, release in a `finally`. Problems with the
 * site's own files do not throw: they come back in `errors` (and the assembly is completed as far as it
 * can be, so that `info` and the manifest still describe it). A broken installation of the package
 * itself (no `site/` folder) and failures of the file system throw.
 */
export async function assemble(args: AssembleArgs, o: AssembleOptions = {}): Promise<Assembly> {
  const { paths, config } = args;
  const env = args.env ?? process.env;
  const siteSource = o.siteSource ?? packageSiteDir();
  const root = paths.root;
  const warnings: string[] = [];
  const errors: string[] = [];
  const skipped: SkippedPath[] = [];
  const shadowed: string[] = [];
  const added: string[] = [];
  const origin = new Map<string, Origin>();

  // 1. Start from nothing. The root is a pure function of the package, the configuration, the
  //    overrides and the Markdown: nothing survives from an earlier run, and the manifest of the
  //    earlier run does not describe the root that is about to exist.
  ensureRealDir(paths.work);
  removeInside(paths.manifest, paths.work);
  removeInside(root, paths.work);
  mkdirSync(root, { recursive: true });
  writeText(join(paths.work, ".gitignore"), "*\n");

  // 2. The package's Jx project files. The base project is read, not copied; the catalog is placed below.
  const broken = (why: string, cause?: unknown): Error =>
    new Error(
      `the site folder of ${name} is ${why} (${siteSource}): the installation is broken, reinstall the package`,
      { cause },
    );
  let packageFiles: string[];
  try {
    packageFiles = packageFilesBelow(siteSource);
  } catch (error) {
    throw broken(`missing or unreadable: ${(error as Error).message}`, error);
  }
  for (const required of ["project.base.json", "data/projects.snapshot.json"]) {
    if (!packageFiles.includes(required)) throw broken(`missing ${required}`);
  }
  for (const rel of packageFiles) {
    if (rel === "project.base.json" || rel.startsWith("data/")) continue;
    copyFile(join(siteSource, ...rel.split("/")), join(root, ...rel.split("/")));
    origin.set(rel, "package");
  }

  // The walk of a folder of the shell: symbolic links follow the policy of 4.1 (fsutil), and a folder
  // that cannot be walked at all (a link to outside the repository) is an error of the site.
  const walk = (folder: string): WalkResult => {
    try {
      const result = walkFiles(join(paths.siteDir, folder), {
        repoRoot: paths.repoRoot,
        siteDir: paths.siteDir,
      });
      for (const s of result.skipped)
        skipped.push({ path: `${folder}/${s.path}`, reason: s.reason });
      return result;
    } catch (error) {
      errors.push(`assemble: ${folder}/: ${(error as Error).message}`);
      return { files: [], skipped: [] };
    }
  };

  // 3. The shell's overrides: a file replaces the package's file of the same path or is added. Dotfiles
  //    (.ejected.json, .DS_Store) are not Jx files. components/ must be flat: Jx registers only
  //    <root>/components/*.json, so a nested file would be silently ignored.
  const ignored = new Set<string>();
  for (const rel of walk("overrides").files) {
    const parts = rel.split("/");
    if (parts.some((part) => part.startsWith("."))) continue;
    const folder = parts[0] ?? "";
    if (parts.length < 2 || !(OVERRIDE_DIRS as readonly string[]).includes(folder)) {
      ignored.add(folder);
      continue;
    }
    if (folder === "components" && parts.length > 2) {
      errors.push(
        `overrides: overrides/${rel} is nested: Jx registers only components/*.json, so move it to overrides/components/${parts.at(-1)}`,
      );
      continue;
    }
    (origin.get(rel) === "package" ? shadowed : added).push(rel);
    copyFile(join(paths.siteDir, "overrides", ...parts), join(root, ...parts));
    origin.set(rel, "override");
  }
  for (const entry of [...ignored].sort(byPath)) {
    const why =
      entry === "project.json"
        ? 'the project is changed with the "jx" setting of docusystem.config.json'
        : entry === "public"
          ? "static files go in public/ next to overrides/, not in it"
          : "only components/, layouts/ and pages/ are read";
    warnings.push(`overrides: overrides/${entry} is ignored: ${why}`);
  }

  // 4. The shell's static files; a file of the same name replaces the package's. CNAME is generated.
  for (const rel of walk("public").files) {
    if (rel.toLowerCase() === "cname") {
      errors.push(
        "assemble: public/CNAME is not allowed: the file is generated from `domain` in docusystem.config.json, delete it",
      );
      continue;
    }
    if (rel.split("/").at(-1) === ".DS_Store") continue;
    const dest = `public/${rel}`;
    if (origin.get(dest) === "package") shadowed.push(dest);
    copyFile(join(paths.siteDir, "public", ...rel.split("/")), join(root, ...dest.split("/")));
    origin.set(dest, "override");
  }

  // 5. Generated files. The theme and the `jx` fragment are checked while the project is generated.
  const project = generateProject(config, {
    strict: args.strict,
    base: readBaseProject(siteSource),
  });
  errors.push(...project.errors.map((message) => `assemble: ${message}`));
  warnings.push(...project.warnings);
  if (hasJxFragment(config)) {
    warnings.push(
      'overrides: the "jx" setting of docusystem.config.json is applied to project.json (unsupported: it does not follow package updates)',
    );
  }
  writeJson(join(root, "project.json"), project.project);
  origin.set("project.json", "generated");

  // `docsPath` is relative to the repository root; the Markdown folder may be the root itself (".").
  const docsPath = relative(paths.repoRoot, paths.docsDir).split(sep).join("/") || ".";
  writeJson(join(root, "docusystem.config.json"), {
    name: config.name,
    tagline: config.tagline,
    slug: config.slug,
    platform: config.platform,
    repo: config.repo,
    domain: config.domain,
    license: config.license,
    branch: args.branch,
    docsPath,
  });
  origin.set("docusystem.config.json", "generated");
  writeText(join(root, "public", "CNAME"), `${config.domain}\n`);
  origin.set("public/CNAME", "generated");

  // The catalog the project switcher is rendered from: bundled, so that the output does not depend on
  // avunu.net at build time; a live copy only when asked for, and only when it passes the contract.
  const snapshot = join(root, "data", "projects.snapshot.json");
  copyFile(join(siteSource, "data", "projects.snapshot.json"), snapshot);
  origin.set("data/projects.snapshot.json", "package");
  let catalog: Manifest["catalog"] = "bundled";
  if (args.refreshCatalog === true) {
    const live = `${snapshot}.live`;
    let message: string;
    try {
      const result = await syncCatalog({
        url: args.catalogUrl ?? env.DOCUSYSTEM_CATALOG_URL ?? CATALOG_URL,
        out: live,
        timeoutMs: CATALOG_TIMEOUT_MS,
      });
      if (result.ok) {
        renameSync(live, snapshot);
        catalog = "live";
        origin.set("data/projects.snapshot.json", "generated");
      }
      message = result.message;
    } catch (error) {
      message = (error as Error).message;
    }
    rmSync(live, { force: true });
    if (catalog === "bundled") {
      // The reason may run over several lines (the problems of a catalog that does not conform): the
      // consequence belongs to the first line, the detail follows it.
      const [reason = "", ...detail] = message.split("\n");
      warnings.push(
        [
          `catalog: ${reason.replace(/:$/, "")}; using the catalog bundled with ${name} ${version}`,
          ...detail,
        ].join("\n"),
      );
    }
  }

  // `.generated/nav.json` is written by step 7, which always follows: the manifest lists it so that it
  // describes the root the build will see. `.generated/docs/` (the staged Markdown) is not listed.
  origin.set(".generated/nav.json", "generated");

  // 6. The Jx packages, resolvable from the root whichever way the package manager laid them out.
  const jx = linkJxPackages(root);

  const manifest: Manifest & { warnings?: string[] } = {
    docusystem: version,
    runtime: runtimeName(),
    jx,
    files: Object.fromEntries([...origin].sort(([a], [b]) => byPath(a, b))),
    shadowed: shadowed.sort(byPath),
    added: added.sort(byPath),
    catalog,
    strict: args.strict,
  };
  // Not part of the frozen Manifest type: recorded only when there is something to record, so that the
  // common manifest is exactly the documented one.
  if (warnings.length > 0) manifest.warnings = [...warnings];
  writeJson(paths.manifest, manifest);

  return {
    manifest,
    shadowed: manifest.shadowed,
    added: manifest.added,
    skipped,
    warnings,
    errors,
  };
}
