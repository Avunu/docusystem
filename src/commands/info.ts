// `docusystem info` (section 4.1): what a maintainer who has never seen this package needs in order to
// debug a build: versions and runtime, the folders involved, the resolved branch, what the shell
// overrides, what the last build did, and the exact command that runs Jx by hand on the assembled
// root. `--json` prints the same as one JSON object; `--nav` also prints the sidebar tree (which
// assembles the root first, because the tree has to match the Markdown as it is now).
//
// It reports what is wrong with the configuration instead of failing on it: this is the command to run
// when something does not build. Exit 0, except when `--nav` was asked for and could not be produced.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runtimeName } from "../lib/ci.js";
import { ConfigError, findSiteDir, pathsFor, readConfig, resolveBranch } from "../lib/config.js";
import { walkFiles } from "../lib/fsutil.js";
import { jxCli, jxVersions } from "../lib/jx.js";
import { name, packageRoot, version, WORKFLOW_CONTRACT } from "../lib/package-info.js";
import { runPipeline } from "../lib/pipeline.js";
import { shellCommand } from "../lib/strict.js";
import type { DocsConfig, Manifest, NavData, NavGroup, Paths } from "../lib/types.js";
import { EXIT, type CommandContext } from "./types.js";

/** Everything `info` knows, before it is printed as text or JSON. */
interface Info {
  docusystem: { name: string; version: string; packageRoot: string };
  runtime: string;
  workflowContract: number;
  jx: Record<string, string>;
  site: string;
  config: DocsConfig | null;
  configProblems: string[];
  paths: Paths | null;
  branch: string | null;
  /** Files of `<site>/overrides` (without the eject record) and `<site>/public`, `/`-separated. */
  overrides: string[];
  publicFiles: string[];
  /** The manifest of the last build, when there was one. */
  lastBuild: Manifest | null;
  jxCommand: string[] | null;
  nav?: NavData;
}

const pad = (label: string): string => `${label}:`.padEnd(12);

function listFiles(dir: string, paths: Paths): string[] {
  try {
    return walkFiles(dir, { repoRoot: paths.repoRoot, siteDir: paths.siteDir }).files;
  } catch (error) {
    return [`(cannot be read: ${(error as Error).message})`];
  }
}

/** The sidebar as an indented tree: the home page, loose pages, then each section with its groups. */
export function navTree(nav: NavData): string[] {
  const lines: string[] = [`${nav.home.label}  ${nav.home.url}`];
  for (const page of nav.loose) lines.push(`${page.label}  ${page.url}`);
  const group = (heading: NavGroup, depth: number): void => {
    lines.push(
      `${"  ".repeat(depth)}${heading.label}/${heading.url === null ? "" : `  ${heading.url}`}`,
    );
    for (const page of heading.pages)
      lines.push(`${"  ".repeat(depth + 1)}${page.label}  ${page.url}`);
  };
  for (const section of nav.sections) {
    group(section, 0);
    for (const sub of section.groups) group(sub, 1);
  }
  return lines;
}

function gather(ctx: CommandContext): Info {
  const site = findSiteDir(ctx.options.site, ctx.cwd);
  const info: Info = {
    docusystem: { name, version, packageRoot },
    runtime: runtimeName(),
    workflowContract: WORKFLOW_CONTRACT,
    jx: {},
    site,
    config: null,
    configProblems: [],
    paths: null,
    branch: null,
    overrides: [],
    publicFiles: [],
    lastBuild: null,
    jxCommand: null,
  };
  try {
    info.jx = jxVersions();
    info.jxCommand = [process.execPath, jxCli()];
  } catch (error) {
    info.configProblems.push(`the Jx packages cannot be found: ${(error as Error).message}`);
  }
  try {
    info.config = readConfig(site);
    info.paths = pathsFor(site, info.config);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    info.configProblems.push(...error.problems);
  }
  const { config, paths } = info;
  if (config !== null && paths !== null) {
    info.branch = resolveBranch(config, paths.repoRoot, ctx.env);
    info.overrides = listFiles(join(site, "overrides"), paths).filter(
      (file) => file !== ".ejected.json",
    );
    info.publicFiles = listFiles(join(site, "public"), paths);
    if (existsSync(paths.manifest)) {
      try {
        info.lastBuild = JSON.parse(readFileSync(paths.manifest, "utf8")) as Manifest;
      } catch {
        // An unreadable manifest is a leftover of an interrupted build: the next build rewrites it.
      }
    }
    if (info.jxCommand !== null) info.jxCommand = [...info.jxCommand, "build", paths.root];
  }
  return info;
}

function render(info: Info): string[] {
  const out: string[] = [
    `${info.docusystem.name} ${info.docusystem.version}  (${info.docusystem.packageRoot})`,
    `${pad("runtime")}${info.runtime}`,
    `${pad("jx")}${
      Object.entries(info.jx)
        .map(([pkg, v]) => `${pkg} ${v}`)
        .join(", ") || "(not found)"
    }`,
    `${pad("contract")}workflow contract ${info.workflowContract}`,
    `${pad("site")}${info.site}`,
  ];
  if (info.config !== null) {
    out.push(
      `${pad("project")}${info.config.name} (${info.config.slug}, ${info.config.platform}), https://${info.config.domain}/`,
    );
  }
  const { paths } = info;
  if (paths !== null) {
    const here = (path: string): string => (existsSync(path) ? "" : "  (missing)");
    out.push(
      `${pad("repository")}${paths.repoRoot}`,
      `${pad("markdown")}${paths.docsDir}${here(paths.docsDir)}`,
      `${pad("branch")}${info.branch ?? "?"}`,
      `${pad("jx root")}${paths.root}${existsSync(paths.root) ? "" : "  (not assembled yet: run docusystem build)"}`,
      `${pad("published")}${paths.dist}${here(paths.dist)}`,
      `${pad("overrides")}${
        info.overrides.length === 0
          ? "none (every file comes from the package)"
          : info.overrides.join(", ")
      }`,
      `${pad("public")}${info.publicFiles.length === 0 ? "none" : info.publicFiles.join(", ")}`,
    );
    const last = info.lastBuild;
    if (last !== null) {
      out.push(
        `${pad("last build")}docusystem ${last.docusystem} on ${last.runtime}, ${last.strict ? "strict" : "lenient"}, ` +
          `catalog ${last.catalog}, ${Object.keys(last.files).length} file(s) in the root` +
          `${last.shadowed.length > 0 ? `, replaces ${last.shadowed.join(", ")}` : ""}` +
          `${last.added.length > 0 ? `, adds ${last.added.join(", ")}` : ""}`,
      );
    }
  }
  if (info.configProblems.length > 0) {
    out.push("", "Problems:");
    for (const problem of info.configProblems) out.push(`  ${problem}`);
  }
  if (info.jxCommand !== null && paths !== null) {
    out.push(
      "",
      "To run Jx by hand on the assembled project (docusystem jx <command> does the same):",
      `  ${shellCommand(info.jxCommand)}`,
    );
  }
  if (info.nav !== undefined) {
    out.push("", "Sidebar:", ...navTree(info.nav).map((line) => `  ${line}`));
  }
  return out;
}

export async function run(ctx: CommandContext): Promise<number> {
  const info = gather(ctx);
  let code: number = EXIT.ok;

  if (ctx.options.nav === true) {
    // The tree has to match the Markdown as it is now: assemble the root up to the nav step (nothing
    // is built or published) and read what it wrote. The progress lines are not wanted here.
    const result = await runPipeline({
      siteArg: ctx.options.site,
      cwd: ctx.cwd,
      env: ctx.env,
      lenient: true,
      stopAfterNav: true,
      log: () => {},
      error: ctx.stderr,
    });
    if (result.ok && result.nav !== undefined) info.nav = result.nav;
    else code = EXIT.problems;
  }

  if (ctx.options.json === true) {
    ctx.stdout(JSON.stringify(info, null, 2));
  } else {
    for (const line of render(info)) ctx.stdout(line);
  }
  return code;
}
