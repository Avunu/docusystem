// `docusystem upgrade` (section 4.1 and 7.6 of the architecture decision record): after the package was
// updated (`npm update @avunu/docusystem`), brings the files `init` wrote in line with the installed
// version, and nothing else. It re-pins every `uses:` line of both caller workflows to the commit of
// the tag of the installed version, and appends the Dependabot entries that are missing. It never
// edits an override, the configuration, or any other line of a workflow.
import { join, relative, sep } from "node:path";
import { findRepoRoot, findSiteDir } from "../lib/config.js";
import {
  cooldownAdvice,
  DependabotShapeError,
  dependabotFile,
  ensureDependabotEntries,
} from "../lib/dependabot.js";
import { version } from "../lib/package-info.js";
import { COMMIT, repinWorkflow, resolvePin, tagOf, type PinResult } from "../lib/pin.js";
import {
  applyChanges,
  planChange,
  readTextOrNull,
  siteDirProblem,
  unifiedDiff,
  type FileChange,
} from "../lib/workflows.js";
import { EXIT, type CommandContext } from "./types.js";

/** What `run` needs from outside; tests replace it so that no network is used. */
export interface UpgradeDeps {
  /** The commit of the tag of the installed version. */
  resolvePin?: (version: string) => PinResult;
}

const CALLERS = ["docs.yml", "docs-publish.yml"] as const;

export async function run(ctx: CommandContext): Promise<number> {
  return runUpgrade(ctx, {});
}

/** `run` with its outside world injectable. */
export async function runUpgrade(ctx: CommandContext, deps: UpgradeDeps): Promise<number> {
  const fail = (message: string): number => {
    ctx.stderr(`docusystem: upgrade: ${message}`);
    return EXIT.problems;
  };
  const dry = ctx.options.dryRun === true;

  let siteDir: string;
  try {
    siteDir = findSiteDir(ctx.options.site, ctx.cwd);
  } catch (error) {
    return fail((error as Error).message);
  }
  const repoRoot = findRepoRoot(siteDir);
  const siteRel = relative(repoRoot, siteDir).split(sep).join("/");

  // The commit the callers are pinned to: asked for before anything is changed.
  let sha = ctx.options.workflowSha?.toLowerCase();
  if (sha !== undefined && !COMMIT.test(sha)) {
    return fail(
      `--workflow-sha must be a full 40-character commit id (got "${ctx.options.workflowSha}")`,
    );
  }
  if (sha === undefined) {
    const found = (deps.resolvePin ?? ((v: string) => resolvePin(v, { env: ctx.env })))(version);
    if (found.sha === null) {
      return fail(
        `could not find the commit of the tag v${version} to pin the workflows to: ${found.reason ?? "unknown"}. ` +
          "Nothing was changed. Pass the commit with --workflow-sha <40-character commit>",
      );
    }
    sha = found.sha;
  }
  const tag = tagOf(version);

  const changes: FileChange[] = [];
  const byHand: string[] = [];
  const read = (rel: string): string | null => readTextOrNull(join(repoRoot, ...rel.split("/")));
  try {
    for (const file of CALLERS) {
      const path = `.github/workflows/${file}`;
      const before = read(path);
      if (before === null) {
        byHand.push(`${path} does not exist: run \`docusystem init\` to write it`);
        continue;
      }
      const after = repinWorkflow(before, sha, version);
      if (after === null) {
        byHand.push(
          `${path} does not call a reusable workflow of Avunu/docusystem (a copy of the starter's workflow?): ` +
            "`docusystem init --force` replaces it with the shared caller",
        );
        continue;
      }
      changes.push(planChange(path, before, after, `pinned to ${tag}`));
    }

    // Dependabot: only for a repository that uses it (a missing file is not created here).
    const dependabot = dependabotFile(repoRoot);
    const text = read(dependabot);
    if (text === null) {
      byHand.push(`${dependabot} does not exist: nothing to add (\`docusystem init\` creates it)`);
    } else if (siteDirProblem(siteRel) !== null) {
      byHand.push(`${siteRel} cannot be a Dependabot directory of the shared workflow`);
    } else {
      try {
        const next = ensureDependabotEntries(text, { site: siteRel, actions: true });
        changes.push(planChange(dependabot, text, next.text, next.changes.join("; ") || undefined));
        for (const advice of cooldownAdvice(next.text, { site: siteRel, actions: true })) {
          byHand.push(`${dependabot}: ${advice}`);
        }
      } catch (error) {
        if (!(error instanceof DependabotShapeError)) throw error;
        byHand.push(
          `${dependabot} ${error.message}; add this to its \`updates:\` list by hand:\n${error.snippet.trimEnd()}`,
        );
      }
    }
  } catch (error) {
    return fail((error as Error).message);
  }

  const todo = changes.filter((change) => change.action !== "unchanged");
  if (!dry) {
    try {
      applyChanges(repoRoot, todo);
    } catch (error) {
      return fail(`${(error as Error).message}. Nothing was changed`);
    }
  }

  ctx.stdout(
    todo.length === 0
      ? `upgrade: nothing to change: the workflows are pinned to ${tag} (${sha.slice(0, 12)})`
      : `upgrade${dry ? " (dry run): would change" : ": changed"} ${todo.length} file${todo.length === 1 ? "" : "s"}; pins are ${tag} (${sha.slice(0, 12)})`,
  );
  for (const change of todo) {
    const verb = dry ? "would update" : "updated";
    ctx.stdout(`  ${verb}  ${change.path}${change.note === undefined ? "" : `  (${change.note})`}`);
  }
  if (dry) {
    for (const change of todo) {
      ctx.stdout("");
      for (const line of unifiedDiff(change.path, change.before, change.after)) ctx.stdout(line);
    }
  }
  if (byHand.length > 0) {
    ctx.stdout("");
    ctx.stdout("Not changed:");
    for (const note of byHand) {
      const [first = "", ...rest] = note.split("\n");
      ctx.stdout(`  ${first}`);
      for (const line of rest) ctx.stdout(`    ${line}`);
    }
  }
  ctx.stdout("");
  ctx.stdout("Next: run `docusystem doctor` to check the rest, and `npm run check`.");
  return EXIT.ok;
}
