// `docusystem lint` (section 4.1): the Markdown checks of the build and nothing else, one line per
// issue as `level: file:line message`, no build and nothing written. Exit 1 when there is an error;
// warnings alone are exit 0.
import { existsSync } from "node:fs";
import { ConfigError, findSiteDir, pathsFor, readConfig } from "../lib/config.js";
import { formatIssue, lintDocs } from "../lib/lint.js";
import { EXIT, type CommandContext } from "./types.js";

export async function run(ctx: CommandContext): Promise<number> {
  const siteDir = findSiteDir(ctx.options.site, ctx.cwd);
  let docsDir: string;
  let repoRoot: string;
  try {
    const config = readConfig(siteDir);
    const paths = pathsFor(siteDir, config);
    docsDir = paths.docsDir;
    repoRoot = paths.repoRoot;
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    for (const problem of error.problems) ctx.stderr(`lint: error: ${problem}`);
    return EXIT.problems;
  }
  if (!existsSync(docsDir)) {
    ctx.stderr(`lint: error: the Markdown folder ${docsDir} does not exist`);
    return EXIT.problems;
  }

  const issues = lintDocs(docsDir, { repoRoot });
  for (const issue of issues) ctx.stdout(`${issue.level}: ${formatIssue(issue)}`);
  const errors = issues.filter((issue) => issue.level === "error").length;
  ctx.stdout(`lint: ${errors} error(s), ${issues.length - errors} warning(s)`);
  return errors > 0 ? EXIT.problems : EXIT.ok;
}
