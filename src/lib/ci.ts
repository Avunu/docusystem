// What `check --ci` says to GitHub Actions (section 4.1, "Output conventions"): workflow commands that
// turn a problem into an annotation on the pull request, a job summary, and the step outputs. Plain
// files and lines: nothing here reads the network or the repository.
//
//   ::error file=docs/x.md,line=3,title=lint::message
//
// The escaping is the one of the Actions toolkit (`%`, CR and LF in the message; also `:` and `,` in a
// property), so that a message with a newline or a percent sign arrives whole.
import { appendFileSync } from "node:fs";
import { jxVersions } from "./jx.js";
import { JX_FRAGMENT } from "./overrides.js";
import { version } from "./package-info.js";
import type { Manifest, Problem } from "./types.js";

const escapeData = (text: string): string =>
  text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");

const escapeProperty = (text: string): string =>
  escapeData(text).replaceAll(":", "%3A").replaceAll(",", "%2C");

/**
 * One GitHub Actions workflow command: `::error file=docs/x.md,line=3,title=lint::message`. `file` is
 * relative to the repository root and `/`-separated; a line without a file is left out (GitHub would
 * not know what it belongs to); `title` is the stage that found the problem.
 */
export function annotation(
  level: "error" | "warning",
  message: string,
  file?: string,
  line?: number,
  title?: string,
): string {
  const properties: string[] = [];
  if (file !== undefined && file !== "") {
    properties.push(`file=${escapeProperty(file)}`);
    if (line !== undefined && line > 0) properties.push(`line=${line}`);
  }
  if (title !== undefined && title !== "") properties.push(`title=${escapeProperty(title)}`);
  return `::${level}${properties.length === 0 ? "" : ` ${properties.join(",")}`}::${escapeData(message)}`;
}

/** Appends `text` to the file `env[variable]` names; false when the variable is unset or empty. */
function appendTo(env: NodeJS.ProcessEnv, variable: string, text: string): boolean {
  const file = env[variable];
  if (file === undefined || file === "") return false;
  appendFileSync(file, text);
  return true;
}

/** Appends Markdown to the job summary (`$GITHUB_STEP_SUMMARY`); false outside GitHub Actions. */
export function appendStepSummary(env: NodeJS.ProcessEnv, markdown: string): boolean {
  return appendTo(env, "GITHUB_STEP_SUMMARY", markdown.endsWith("\n") ? markdown : `${markdown}\n`);
}

/** Appends `name=value` lines to the step outputs (`$GITHUB_OUTPUT`); false outside GitHub Actions. */
export function appendStepOutputs(
  env: NodeJS.ProcessEnv,
  outputs: Record<string, string>,
): boolean {
  const lines = Object.entries(outputs).map(([name, value]) => {
    if (/[\r\n]/.test(value)) throw new Error(`the step output ${name} has a line break`);
    return `${name}=${value}\n`;
  });
  return appendTo(env, "GITHUB_OUTPUT", lines.join(""));
}

/** One line of the table of the job summary. */
export interface SummaryStep {
  name: string;
  ok: boolean;
  detail: string;
}

export interface SummaryInput {
  passed: boolean;
  /** The configured domain, when the configuration was read. */
  domain?: string;
  steps: SummaryStep[];
  /** The `info` essentials, so that a red run can be read without a checkout. */
  versions: { docusystem: string; runtime: string; jx: Record<string, string> };
  catalog?: string;
  overrides?: { shadowed: string[]; added: string[]; jx?: boolean };
  problems: Problem[];
}

/** The most problems the summary lists; the log has all of them. */
const SUMMARY_PROBLEMS = 20;

/** The job summary of `check --ci`, as Markdown. */
export function renderSummary(input: SummaryInput): string {
  const out: string[] = [`### Documentation check: ${input.passed ? "passed" : "failed"}`, ""];
  out.push("| Step | Result |", "| --- | --- |");
  for (const step of input.steps) {
    out.push(
      `| ${step.name} | ${step.ok ? "ok" : "FAILED"}: ${step.detail.replaceAll("|", "\\|")} |`,
    );
  }
  out.push("");
  if (input.domain !== undefined) {
    out.push(`The site is published at https://${input.domain}/ once it is deployed.`, "");
  }

  const errors = input.problems.filter((problem) => problem.level === "error");
  const warnings = input.problems.filter((problem) => problem.level === "warning");
  if (input.problems.length > 0) {
    out.push(
      `#### Problems: ${errors.length} error(s), ${warnings.length} warning(s)`,
      "",
      "```text",
    );
    for (const problem of input.problems.slice(0, SUMMARY_PROBLEMS)) {
      const where =
        problem.file === undefined
          ? ""
          : `${problem.file}${problem.line === undefined ? "" : `:${problem.line}`}  `;
      out.push(`${problem.level}: ${where}${problem.message.replaceAll("```", "'''")}`);
    }
    if (input.problems.length > SUMMARY_PROBLEMS) {
      out.push(`... and ${input.problems.length - SUMMARY_PROBLEMS} more (see the log)`);
    }
    out.push("```", "");
  }

  out.push("#### Build", "");
  out.push(`- @avunu/docusystem ${input.versions.docusystem}, ${input.versions.runtime}`);
  const jx = Object.entries(input.versions.jx).map(([pkg, installed]) => `${pkg} ${installed}`);
  if (jx.length > 0) out.push(`- ${jx.join(", ")}`);
  if (input.catalog !== undefined) out.push(`- project catalog: ${input.catalog}`);
  const overrides = input.overrides;
  if (overrides !== undefined) {
    const listed = [
      ...overrides.shadowed.map((file) => `${file} (replaces the package's file)`),
      ...overrides.added.map((file) => `${file} (added)`),
      ...(overrides.jx === true ? [JX_FRAGMENT] : []),
    ];
    out.push(`- overrides: ${listed.length === 0 ? "none" : listed.join(", ")}`);
  }
  out.push("");
  return out.join("\n");
}

/** `node 24.21.0` or `bun 1.4.2`: the runtime this process is. */
export function runtimeName(): string {
  const bun = process.versions.bun;
  return bun === undefined ? `node ${process.versions.node}` : `bun ${bun}`;
}

/**
 * The versions a summary (and `info`) states: the manifest of the build that just ran, or, when none
 * was written because the run stopped before assembling, what this process knows itself.
 */
export function versionsOf(manifest?: Pick<Manifest, "docusystem" | "runtime" | "jx">): {
  docusystem: string;
  runtime: string;
  jx: Record<string, string>;
} {
  if (manifest !== undefined) {
    return { docusystem: manifest.docusystem, runtime: manifest.runtime, jx: manifest.jx };
  }
  let jx: Record<string, string> = {};
  try {
    jx = jxVersions();
  } catch {
    // The Jx packages are not installed where this package looks (a broken install): say less, not fail.
  }
  return { docusystem: version, runtime: runtimeName(), jx };
}
