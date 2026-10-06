// `docusystem doctor` (section 4.1.3 of the architecture decision record): the maintainer's checklist,
// as far as a clone shows it. Every check reads files of the repository; nothing touches the network.
// What lives in GitHub, DNS and avunu.net (the Pages source and domain, the DOCS_SITE_ENABLED variable,
// branch protection) cannot be seen from a clone: the command prints the exact values to set instead.
//
// Each finding is `ok`, `warning` or `error`; any error makes the exit code 1. The Dependabot file and
// the workflows are read as YAML, entry by entry and job by job: a pattern match over the text would
// call `npm /` followed by `bun /docs-site` an npm entry for the site (a "false OK" the judges found).
import { existsSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import {
  hasSiteExclusion,
  isAutoMergeWorkflow,
  siteBranchPrefix,
  withoutComments,
} from "../lib/automerge.js";
import { ConfigError, findRepoRoot, findSiteDir, pathsFor, readConfig } from "../lib/config.js";
import { dependabotFile, readDependabotEntries, type DependabotEntry } from "../lib/dependabot.js";
import { isInside } from "../lib/fsutil.js";
import { overrideFindings } from "../lib/overrides.js";
import { major, REPOSITORY, version } from "../lib/package-info.js";
import { COMMIT } from "../lib/pin.js";
import { checkSlug } from "../lib/preflight.js";
import type { DocsConfig, Finding } from "../lib/types.js";
import {
  folderGlob,
  inspectCaller,
  maintainerSteps,
  readTextOrNull,
  type CallerInfo,
  type WorkflowUse,
} from "../lib/workflows.js";
import { EXIT, type CommandContext } from "./types.js";

type Add = (level: Finding["level"], message: string) => void;

const posix = (path: string): string => path.split(sep).join("/");

/** The files of the Markdown folder that make a home page. */
const HOME_PAGES = ["README.md", "readme.md", "index.md"];

/** Folders and files of the copied starter that a shell does not have (2.4). */
const STARTER_LEFTOVERS = ["components", "layouts", "pages", "project.json", "scripts"];

/** Formatter configurations that may reformat the Markdown of `docs/`. */
const FORMATTER_CONFIGS = [
  ".oxfmtrc.json",
  ".oxfmtrc.jsonc",
  ".prettierrc",
  ".prettierrc.json",
  ".prettierrc.yml",
  ".prettierrc.yaml",
  ".prettierrc.js",
  ".prettierrc.cjs",
  ".prettierrc.mjs",
  ".prettierrc.toml",
  "prettier.config.js",
  "prettier.config.cjs",
  "prettier.config.mjs",
  "biome.json",
  "biome.jsonc",
  "dprint.json",
];

const WORKFLOWS = ".github/workflows";

/** The workflow files of the repository, sorted: [file name, text]. */
function workflowFiles(repoRoot: string): Array<[string, string]> {
  const dir = join(repoRoot, ".github", "workflows");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => /\.ya?ml$/.test(file))
    .sort()
    .flatMap((file) => {
      const text = readTextOrNull(join(dir, file));
      return text === null ? [] : [[file, text] as [string, string]];
    });
}

// ---- config and docs ----

function checkConfig(site: string, add: Add): DocsConfig | null {
  let config: DocsConfig;
  try {
    config = readConfig(site);
  } catch (error) {
    if (error instanceof ConfigError) {
      for (const problem of error.problems) add("error", `config: ${problem}`);
    } else {
      add("error", `config: ${(error as Error).message}`);
    }
    return null;
  }
  add("ok", `config: valid (${config.name}, ${config.domain})`);
  const slug = checkSlug(config.slug);
  if (slug.error !== undefined) add("error", `config: ${slug.error}`);
  else if (slug.warning !== undefined) add("warning", `config: ${slug.warning}`);
  return config;
}

/** Checks the home page; returns the Markdown folder relative to the repository root, or null. */
function checkDocs(
  site: string,
  repoRoot: string,
  config: DocsConfig | null,
  add: Add,
): string | null {
  let docsDir: string;
  try {
    docsDir = config === null ? resolve(site, "..", "docs") : pathsFor(site, config).docsDir;
  } catch (error) {
    add("error", `docs: ${(error as Error).message}`);
    return null;
  }
  if (!isInside(repoRoot, docsDir)) {
    add(
      "error",
      `docs: the folder ${docsDir} is outside the repository: files from outside the repository are never published`,
    );
    return null;
  }
  const docsRel = posix(relative(repoRoot, docsDir));
  const shown = docsRel === "" ? "." : docsRel;
  const names = existsSync(docsDir) ? readdirSync(docsDir) : [];
  if (HOME_PAGES.some((page) => names.includes(page))) {
    add("ok", `docs: ${shown}/ has a home page`);
  } else {
    add(
      "error",
      `docs: ${shown}/ has no README.md, readme.md or index.md, so the site has no home page: ` +
        `copy the project's README there (cp README.md ${docsRel === "" ? "" : `${docsRel}/`}README.md) or run \`docusystem init --from-readme\``,
    );
  }
  return docsRel;
}

// ---- workflows ----

function checkPin(where: string, use: WorkflowUse, add: Add): void {
  const label = `${where}: ${use.workflow}`;
  if (!COMMIT.test(use.ref)) {
    add(
      "error",
      `${label} is called by "${use.ref}", not by a commit: a tag or a branch can move, and this workflow publishes the site. ` +
        "Run `docusystem upgrade` to pin it",
    );
    return;
  }
  if (use.version === null) {
    add(
      "warning",
      `${label} is pinned to a commit without a "# vX.Y.Z" comment: nothing says which release it is, and Dependabot's pull requests cannot say what changed`,
    );
    return;
  }
  if (Number.parseInt(use.version, 10) !== major) {
    add(
      "error",
      `${label} is pinned to v${use.version} but ${version} is installed, a different major: the workflow and the package may not work together. Run \`docusystem upgrade\``,
    );
  } else if (use.version !== version) {
    add(
      "warning",
      `${label} is pinned to v${use.version} and ${version} is installed: fine within a major; \`docusystem upgrade\` aligns them`,
    );
  } else {
    add("ok", `${label} is pinned to a commit (v${use.version})`);
  }
}

/** Every `permissions:` of the file (workflow level and jobs) that grants write access. */
function writePermissions(info: CallerInfo): string[] {
  return [
    ...info.writes.map((name) => `${name}: write`),
    ...info.jobs.flatMap((job) => job.writes.map((name) => `${name}: write (job ${job.id})`)),
  ];
}

function checkCaller(
  file: "docs.yml" | "docs-publish.yml",
  o: { repoRoot: string; siteRel: string; docsRel: string | null },
  add: Add,
): void {
  const where = `${WORKFLOWS}/${file}`;
  let text: string | null;
  try {
    text = readTextOrNull(join(o.repoRoot, ...where.split("/")));
  } catch (error) {
    add("error", `${where}: ${(error as Error).message}`);
    return;
  }
  if (text === null) {
    add("error", `${where} is missing: run \`docusystem init\``);
    return;
  }
  const info = inspectCaller(text);
  if (info.error !== null) {
    add("error", `${where} is not valid YAML (${info.error})`);
    return;
  }
  const calls = (workflow: string): WorkflowUse[] =>
    info.uses.filter((use) => use.workflow === workflow);
  const needed = file === "docs.yml" ? ["docs-build.yml"] : ["docs-build.yml", "docs-deploy.yml"];
  let calling = true;
  for (const workflow of needed) {
    if (calls(workflow).length === 0) {
      calling = false;
      add(
        "error",
        `${where} does not call ${REPOSITORY}/.github/workflows/${workflow} (a copy of the starter's workflow?): ` +
          "`docusystem init --force` replaces it with the shared caller",
      );
    }
  }
  for (const use of info.uses) checkPin(where, use, add);

  const forbidden = info.triggers.filter(
    (event) => event === "pull_request_target" || event === "workflow_run",
  );
  for (const event of forbidden) {
    add(
      "error",
      `${where} is triggered by ${event}: it would run with the privileges of the base repository on code from a pull request. Use pull_request (docs.yml) or push (docs-publish.yml)`,
    );
  }
  if (file === "docs.yml") {
    for (const grant of writePermissions(info)) {
      add(
        "error",
        `${where} grants ${grant}: the pull request check must have a read-only token (only docs-publish.yml publishes)`,
      );
    }
  } else if (info.triggers.includes("pull_request")) {
    add(
      "error",
      `${where} is triggered by pull_request but asks for pages: write and id-token: write: nothing a pull request can trigger may publish. It runs on push and by hand only`,
    );
  }

  // `docs-publish.yml`: the deploy job waits for the variable and holds the two permissions.
  if (file === "docs-publish.yml") {
    for (const job of info.jobs.filter((j) => j.uses?.includes("/docs-deploy.yml@"))) {
      if (job.if === null || !job.if.includes("vars.DOCS_SITE_ENABLED")) {
        add(
          "error",
          `${where}: job ${job.id} has no \`if: \${{ vars.DOCS_SITE_ENABLED == 'true' }}\` gate: it would publish before a maintainer has enabled Pages`,
        );
      }
      for (const permission of ["pages", "id-token"]) {
        if (!job.writes.includes(permission) && !job.writes.includes("write-all")) {
          add(
            "error",
            `${where}: job ${job.id} does not grant ${permission}: write (a called workflow cannot widen its caller's permissions)`,
          );
        }
      }
    }
  }

  // The folders the callers name agree with the configuration.
  for (const job of info.jobs.filter((j) => j.uses?.includes("/docs-build.yml@"))) {
    const given =
      typeof job.with["site-directory"] === "string" ? job.with["site-directory"] : "docs-site";
    if (given !== o.siteRel) {
      add(
        "error",
        `${where}: job ${job.id} builds site-directory "${given}" but the site folder is ${o.siteRel}`,
      );
    }
  }
  const event = file === "docs.yml" ? "pull_request" : "push";
  const paths = info.paths[event] ?? [];
  if (paths.length > 0) {
    const wanted = [folderGlob(o.siteRel), ...(o.docsRel === null ? [] : [folderGlob(o.docsRel)])];
    const missing = wanted.filter((glob) => !paths.includes(glob));
    if (missing.length > 0) {
      add(
        "error",
        `${where}: on.${event}.paths does not list ${missing.map((glob) => `"${glob}"`).join(", ")}: a change there would not run the workflow`,
      );
    }
  }
  for (const [trigger, branches] of Object.entries(info.branches)) {
    if (branches.length > 0) {
      add(
        "warning",
        `${where}: on.${trigger}.branches names ${branches.join(", ")}: the shared workflows read the default branch themselves, so a default-branch rename would need an edit here`,
      );
    }
  }
  if (calling && forbidden.length === 0)
    add("ok", `${where}: calls the shared workflow${needed.length > 1 ? "s" : ""}`);
}

// ---- Dependabot, auto-merge, lockfile ----

function checkLockfile(site: string, siteRel: string, add: Add): "npm" | "bun" {
  const bun = ["bun.lock", "bun.lockb"].filter((file) => existsSync(join(site, file)));
  const npm = existsSync(join(site, "package-lock.json"));
  for (const file of bun) {
    add(
      "error",
      `${siteRel}/${file} exists: the shared workflow refuses Bun lockfiles (npm ci needs package-lock.json). Delete it and run npm install`,
    );
  }
  if (!npm && bun.length === 0) {
    add(
      "error",
      `${siteRel}/ has no package-lock.json: the workflow installs from it. Run npm install in ${siteRel} and commit the file`,
    );
  }
  if (npm && bun.length > 0) {
    add(
      "error",
      `${siteRel}/ has both package-lock.json and ${bun.join(", ")}: keep package-lock.json only`,
    );
  }
  if (npm && bun.length === 0) add("ok", `${siteRel}/package-lock.json is the lockfile`);
  return bun.length > 0 && !npm ? "bun" : "npm";
}

function checkDependabot(
  repoRoot: string,
  siteRel: string,
  ecosystem: "npm" | "bun",
  add: Add,
): void {
  const where = dependabotFile(repoRoot);
  const text = ((): string | null => {
    try {
      return readTextOrNull(join(repoRoot, ...where.split("/")));
    } catch {
      return null;
    }
  })();
  const directory = `/${siteRel}`;
  let entries: DependabotEntry[] = [];
  if (text !== null) {
    const read = readDependabotEntries(text);
    if (read.error !== undefined) {
      add(
        "warning",
        `${where} cannot be read (${read.error}): its entries for ${directory} and the workflows cannot be checked`,
      );
      return;
    }
    entries = read.entries;
  }
  const absent = text === null ? `${where} does not exist, so there is no` : `${where} has no`;
  const siteEntries = entries.filter((entry) => entry.directories.includes(directory));
  const right = siteEntries.filter((entry) => entry.ecosystem === ecosystem);
  if (siteEntries.length === 0) {
    add(
      "warning",
      `${absent} ${ecosystem} entry for ${directory}: the site's packages (@avunu/docusystem) would never be updated. \`docusystem upgrade\` adds it`,
    );
  } else if (right.length === 0) {
    add(
      "warning",
      `${where} watches ${directory} as ${siteEntries.map((e) => e.ecosystem).join(", ")}, but the site's lockfile is ${ecosystem === "npm" ? "package-lock.json (ecosystem npm)" : "bun.lock (ecosystem bun)"}: ` +
        `change the entry to ${ecosystem}. \`docusystem upgrade\` converts a bun entry`,
    );
  } else {
    add("ok", `${where}: Dependabot watches ${directory} (${ecosystem})`);
    for (const entry of right) {
      if (entry.cooldown.present && !entry.cooldown.excludes.includes("@avunu/docusystem")) {
        add(
          "warning",
          `${where}: the ${ecosystem} entry for ${directory} has a cooldown that does not exclude "@avunu/docusystem": releases of the package would wait for it. Add it under cooldown.exclude`,
        );
      }
    }
  }
  const actions = entries.filter(
    (entry) => entry.ecosystem === "github-actions" && entry.directories.includes("/"),
  );
  if (actions.length === 0) {
    add(
      "warning",
      `${absent} github-actions entry for /: the pinned commits of the shared workflows would never be updated. \`docusystem upgrade\` adds it`,
    );
  } else {
    add("ok", `${where}: Dependabot watches the workflows (github-actions)`);
    for (const entry of actions) {
      if (entry.cooldown.present && !entry.cooldown.excludes.includes(REPOSITORY)) {
        add(
          "warning",
          `${where}: the github-actions entry has a cooldown that does not exclude ${REPOSITORY}: a new release of the shared workflows would wait for it. Add ${REPOSITORY} under cooldown.exclude`,
        );
      }
    }
  }
}

function checkAutoMerge(repoRoot: string, siteRel: string, add: Add): void {
  const prefix = siteBranchPrefix(siteRel);
  let found = false;
  for (const [file, text] of workflowFiles(repoRoot)) {
    if (!isAutoMergeWorkflow(text)) continue;
    found = true;
    const where = `${WORKFLOWS}/${file}`;
    if (hasSiteExclusion(text, siteRel)) {
      add("ok", `${where}: leaves the site's Dependabot pull requests to a person`);
    } else if (withoutComments(text).includes(`dependabot/bun/${siteRel}`)) {
      add(
        "error",
        `${where} excludes dependabot/bun/${siteRel}, but the site's lockfile makes Dependabot's ecosystem npm: its branches are ${prefix}/...  ` +
          `Change the exclusion to !startsWith(github.head_ref, '${prefix}') (\`docusystem init\` does)`,
      );
    } else {
      add(
        "error",
        `${where} merges Dependabot's pull requests but does not skip the site's: a merge to the default branch publishes the site. ` +
          `Add !startsWith(github.head_ref, '${prefix}') to the condition (\`docusystem init\` does)`,
      );
    }
  }
  if (!found) add("ok", "no Dependabot auto-merge workflow to adjust");
}

// ---- overrides and the rest of the repository ----

function checkOverrides(site: string, add: Add): void {
  if (!existsSync(join(site, "overrides"))) {
    add("ok", "overrides: none; the site follows the package");
    return;
  }
  let findings: Finding[];
  try {
    findings = overrideFindings(site);
  } catch (error) {
    add("error", `overrides: cannot be checked (${(error as Error).message})`);
    return;
  }
  for (const finding of findings) add(finding.level, finding.message);
}

function checkRepo(site: string, siteRel: string, repoRoot: string, add: Add): void {
  const hooks = join(repoRoot, ".pre-commit-config.yaml");
  const text = ((): string | null => {
    try {
      return readTextOrNull(hooks);
    } catch {
      return null;
    }
  })();
  if (text !== null && /copyright/i.test(text)) {
    add(
      "warning",
      ".pre-commit-config.yaml has a copyright hook: exclude ^docs/ from it. A stamp above the front matter is repaired for the site, but GitHub and Obsidian read the unrepaired file",
    );
  }
  const manifest = ((): Record<string, unknown> | null => {
    try {
      const parsed: unknown = JSON.parse(readTextOrNull(join(site, "package.json")) ?? "null");
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  })();
  if (manifest !== null) {
    const record = (value: unknown): Record<string, unknown> =>
      typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    const starter = [
      ...(record(manifest.scripts).postinstall === undefined ? [] : ["a postinstall script"]),
      ...["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"].flatMap(
        (section) =>
          Object.keys(record(manifest[section]))
            .filter((dependency) => dependency.startsWith("@jxsuite/"))
            .map((dependency) => `a dependency on ${dependency}`),
      ),
    ];
    if (starter.length > 0) {
      add(
        "warning",
        `${siteRel}/package.json has ${starter.join(", ")}: it is a copy of the starter. The package picks and pins Jx and runs no install script, so a shell has neither. \`docusystem init --force\` rewrites it`,
      );
    }
  }
  const leftovers = STARTER_LEFTOVERS.filter((name) => existsSync(join(site, name)));
  if (leftovers.length > 0) {
    add(
      "warning",
      `${siteRel}/ has ${leftovers.join(", ")}: leftovers of the copied starter. The package owns components, layouts, pages and the project file; remove them (an intended change belongs in overrides/)`,
    );
  }
  const formatters = FORMATTER_CONFIGS.filter((name) => existsSync(join(repoRoot, name)));
  if (formatters.length > 0) {
    add(
      "ok",
      `note: ${formatters.join(", ")} may reformat the Markdown of docs/; exclude the folder if that is not wanted (it is not checked here)`,
    );
  }
}

/** The maintainer checklist (4.1.3) as far as the repository shows it; offline. */
export function diagnose(siteDir: string): Finding[] {
  const out: Finding[] = [];
  const add: Add = (level, message) => {
    out.push({ level, message });
  };
  const site = resolve(siteDir);
  const repoRoot = findRepoRoot(site);
  const siteRel = posix(relative(repoRoot, site));

  const config = checkConfig(site, add);
  const docsRel = checkDocs(site, repoRoot, config, add);
  checkCaller("docs.yml", { repoRoot, siteRel, docsRel }, add);
  checkCaller("docs-publish.yml", { repoRoot, siteRel, docsRel }, add);
  const ecosystem = checkLockfile(site, siteRel, add);
  checkDependabot(repoRoot, siteRel, ecosystem, add);
  checkAutoMerge(repoRoot, siteRel, add);
  checkOverrides(site, add);
  checkRepo(site, siteRel, repoRoot, add);
  return out;
}

const COLORS = { ok: "32", warning: "33", error: "31" } as const;

export async function run(ctx: CommandContext): Promise<number> {
  let siteDir: string;
  try {
    siteDir = findSiteDir(ctx.options.site, ctx.cwd);
  } catch (error) {
    ctx.stderr(`docusystem: doctor: ${(error as Error).message}`);
    return EXIT.problems;
  }
  const findings = diagnose(siteDir);
  const errors = findings.filter((finding) => finding.level === "error").length;
  const warnings = findings.filter((finding) => finding.level === "warning").length;
  let config: DocsConfig | null = null;
  try {
    config = readConfig(siteDir);
  } catch {
    // reported as findings
  }
  const maintainer = config === null ? [] : maintainerSteps(config);

  if (ctx.options.json === true) {
    ctx.stdout(
      JSON.stringify(
        { site: siteDir, ok: errors === 0, errors, warnings, findings, maintainer },
        null,
        2,
      ),
    );
    return errors > 0 ? EXIT.problems : EXIT.ok;
  }

  const label = (level: Finding["level"]): string => {
    const word = level.padEnd(7);
    return ctx.color ? `\u001B[${COLORS[level]}m${word}\u001B[0m` : word;
  };
  for (const finding of findings) ctx.stdout(`${label(finding.level)}  ${finding.message}`);
  ctx.stdout("");
  ctx.stdout(
    errors === 0
      ? `doctor: no errors${warnings === 0 ? "" : `, ${warnings} warning${warnings === 1 ? "" : "s"}`}`
      : `doctor: ${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}`,
  );
  if (maintainer.length > 0) {
    ctx.stdout("");
    ctx.stdout("A maintainer still has to (none of it can be checked from a clone):");
    for (const step of maintainer) ctx.stdout(`  - ${step}`);
  }
  return errors > 0 ? EXIT.problems : EXIT.ok;
}
