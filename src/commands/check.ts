// `docusystem check` (section 4.1): what CI runs. A strict build (steps 1 to 14), then the contrast gate
// on the tokens the site resolved to (15) and a crawl of the published site (16), then, with --ci, the
// job summary and the step outputs (17).
//
// Always strict: `--lenient` is a usage error (main.ts) and DOCUSYSTEM_LENIENT is ignored here. The
// steps after the build run as far as they can be trusted: the contrast gate needs only the root the
// build assembled, so it runs after a failed build too (a red run then shows both problems at once);
// the crawl needs the published site, so it runs only after a passing build.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  annotation,
  appendStepOutputs,
  appendStepSummary,
  renderSummary,
  versionsOf,
  type SummaryStep,
} from "../lib/ci.js";
import { contrastFailures, highlightOf } from "../lib/contrast.js";
import { checkLinks, formatIssues } from "../lib/links.js";
import { hasJxFragment } from "../lib/overrides.js";
import { runPipeline } from "../lib/pipeline.js";
import type { Paths, Problem } from "../lib/types.js";
import { EXIT, type CommandContext } from "./types.js";

/** `style` of the root's project.json, and the search highlight of its docs-search component. */
function readTokens(root: string): {
  style: Record<string, unknown>;
  highlight: ReturnType<typeof highlightOf>;
} {
  const project = JSON.parse(readFileSync(join(root, "project.json"), "utf8")) as {
    style?: Record<string, unknown>;
  };
  if (project.style === undefined || typeof project.style !== "object") {
    throw new Error("project.json has no style object");
  }
  let rule: Record<string, unknown> | undefined;
  try {
    const search = JSON.parse(
      readFileSync(join(root, "components", "docs-search.json"), "utf8"),
    ) as { style?: Record<string, Record<string, unknown>> };
    rule = search.style?.["& .hl"];
  } catch (error) {
    // A shell that removed the search component has no highlight to check; any other trouble is real.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { style: project.style, highlight: highlightOf(rule) };
}

export async function run(ctx: CommandContext): Promise<number> {
  const ci = ctx.options.ci === true || ctx.env.GITHUB_ACTIONS === "true";
  // check is always strict, and does not read DOCUSYSTEM_LENIENT (4.1): take it out of what it passes on.
  const env = { ...ctx.env };
  delete env.DOCUSYSTEM_LENIENT;

  const build = await runPipeline({
    siteArg: ctx.options.site,
    cwd: ctx.cwd,
    env,
    strict: true,
    refreshCatalog: ctx.options.refreshCatalog,
    ci,
    log: ctx.stdout,
    error: ctx.stderr,
  });
  const problems: Problem[] = [...build.problems];
  const steps: SummaryStep[] = [
    {
      name: "Build",
      ok: build.ok,
      detail: build.ok
        ? `${build.pages} page(s) written`
        : `${build.problems.filter((p) => p.level === "error").length} error(s), nothing was published`,
    },
  ];
  let failed = !build.ok;
  const paths: Paths | undefined = build.paths;

  // ---- step 15: contrast ----
  // Needs the root this run assembled; a root that could not be assembled has no tokens to read.
  if (build.assembly !== undefined && build.assembly.errors.length === 0 && paths !== undefined) {
    let tokens: ReturnType<typeof readTokens> | undefined;
    try {
      tokens = readTokens(paths.root);
    } catch (error) {
      const message = `cannot read the resolved design tokens: ${(error as Error).message}`;
      ctx.stderr(`contrast: error: ${message}`);
      if (ci) ctx.stdout(annotation("error", message, undefined, undefined, "contrast"));
      problems.push({ level: "error", message: `contrast: ${message}` });
      steps.push({ name: "Contrast", ok: false, detail: message });
      failed = true;
    }
    if (tokens !== undefined) {
      const contrast = contrastFailures(tokens.style, tokens.highlight);
      ctx.stdout(
        `contrast: ${contrast.checked} color pair(s) checked, ${contrast.failures.length} below the minimum`,
      );
      for (const failure of contrast.failures) {
        const message = `${failure.theme}: ${failure.label} is ${failure.ratio}:1, needs ${failure.minimum}:1`;
        ctx.stderr(`contrast: error: ${message}`);
        if (ci) ctx.stdout(annotation("error", message, undefined, undefined, "contrast"));
        problems.push({ level: "error", message: `contrast: ${message}` });
      }
      steps.push({
        name: "Contrast",
        ok: contrast.failures.length === 0,
        detail: `${contrast.checked} color pair(s), ${contrast.failures.length} below the minimum`,
      });
      if (contrast.failures.length > 0) failed = true;
    }
  }

  // ---- step 16: links ----
  if (build.ok && paths !== undefined) {
    const report = checkLinks(paths.dist, build.nav === undefined ? undefined : { nav: build.nav });
    ctx.stdout(`links: ${report.pages} page(s), ${report.checked} reference(s) checked`);
    if (report.warnings.length > 0) {
      for (const line of formatIssues(report.warnings).split("\n")) {
        ctx.stderr(`links: warning: ${line}`);
      }
    }
    if (report.errors.length > 0) {
      for (const line of formatIssues(report.errors).split("\n")) {
        ctx.stderr(`links: error: ${line}`);
      }
    }
    for (const issue of report.errors) {
      const message = `${issue.page}  ${issue.message}`;
      if (ci) ctx.stdout(annotation("error", message, undefined, undefined, "links"));
      problems.push({ level: "error", message: `links: ${message}` });
    }
    for (const issue of report.warnings) {
      problems.push({ level: "warning", message: `links: ${issue.page}  ${issue.message}` });
    }
    steps.push({
      name: "Links",
      ok: report.errors.length === 0,
      detail: `${report.pages} page(s), ${report.checked} reference(s), ${report.errors.length} error(s), ${report.warnings.length} warning(s)`,
    });
    if (report.errors.length > 0) failed = true;
  }

  // ---- step 17: the summary and the outputs, then the verdict ----
  if (ci) {
    const markdown = renderSummary({
      passed: !failed,
      domain: build.config?.domain,
      steps,
      versions: versionsOf(build.assembly?.manifest),
      catalog: build.assembly === undefined ? undefined : build.assembly.manifest.catalog,
      overrides:
        build.assembly === undefined
          ? undefined
          : {
              shadowed: build.assembly.shadowed,
              added: build.assembly.added,
              jx: hasJxFragment(build.config),
            },
      problems,
    });
    appendStepSummary(ctx.env, markdown);
    if (!failed && paths !== undefined && build.config !== undefined) {
      appendStepOutputs(ctx.env, {
        dist: paths.dist,
        "page-url": `https://${build.config.domain}/`,
        pages: String(build.pages),
      });
    }
  }
  ctx.stdout(failed ? "check: FAILED" : "check: all steps passed");
  return failed ? EXIT.problems : EXIT.ok;
}
