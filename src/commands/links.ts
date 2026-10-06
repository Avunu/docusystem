// `docusystem links [dist]` (section 4.1): the link crawl of `check` on a site that is built already,
// by default `<site>/dist`. Every link, anchor, asset, search result and sidebar entry has to resolve.
// The sidebar entries come from the nav data of the last build (`.docusystem/site/.generated/nav.json`);
// without it (a dist built elsewhere) the crawl still checks everything else and says so.
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { ConfigError, findSiteDir, pathsFor, readConfig } from "../lib/config.js";
import { checkLinks, formatIssues } from "../lib/links.js";
import type { NavData } from "../lib/types.js";
import { EXIT, type CommandContext } from "./types.js";

export async function run(ctx: CommandContext): Promise<number> {
  const siteDir = findSiteDir(ctx.options.site, ctx.cwd);
  let paths;
  try {
    paths = pathsFor(siteDir, readConfig(siteDir));
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    for (const problem of error.problems) ctx.stderr(`links: error: ${problem}`);
    return EXIT.problems;
  }

  const given = ctx.args[0];
  const dist = given === undefined ? paths.dist : resolve(ctx.cwd, given);
  if (!existsSync(dist) || !statSync(dist).isDirectory()) {
    ctx.stderr(
      `links: error: ${dist} is not a built site${given === undefined ? ": run docusystem build first" : ""}`,
    );
    return EXIT.problems;
  }

  let nav: NavData | undefined;
  if (existsSync(paths.navFile)) {
    try {
      nav = JSON.parse(readFileSync(paths.navFile, "utf8")) as NavData;
    } catch (error) {
      ctx.stderr(
        `links: warning: ${paths.navFile} is not readable (${(error as Error).message}): the sidebar is not crawled`,
      );
    }
  } else {
    ctx.stderr(
      `links: warning: no nav data at ${paths.navFile} (run docusystem build): the sidebar is not crawled`,
    );
  }

  const report = checkLinks(dist, nav === undefined ? undefined : { nav });
  ctx.stdout(`links: ${report.pages} page(s), ${report.checked} reference(s) checked`);
  if (report.warnings.length > 0) {
    for (const line of formatIssues(report.warnings).split("\n")) {
      ctx.stderr(`links: warning: ${line}`);
    }
  }
  if (report.errors.length > 0) {
    for (const line of formatIssues(report.errors).split("\n")) ctx.stderr(`links: error: ${line}`);
    ctx.stderr(`links: ${report.errors.length} error(s)`);
    return EXIT.problems;
  }
  return EXIT.ok;
}
