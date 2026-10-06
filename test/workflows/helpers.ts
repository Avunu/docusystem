// Shared by the tests of the workflows and the release engineering (WP8): reading the workflow files
// as data, and the callers a consuming repository has (the fixtures, and the real ones as soon as the
// packages that own them have landed).
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { REPO_ROOT } from "../support/index.js";

/**
 * Whether the shell scripts of the workflows can be run for real here: bash (not on Windows, which is
 * unsupported and where `bash` may be a different program) and jq, which the runners have.
 */
export const hasBash: boolean =
  process.platform !== "win32" && spawnSync("bash", ["--version"]).status === 0;
export const hasJq: boolean = hasBash && spawnSync("jq", ["--version"]).status === 0;

export type Permissions = Record<string, string>;

export interface Step {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  if?: string | boolean;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
  "working-directory"?: string;
}

export interface Job {
  name?: string;
  needs?: string | string[];
  if?: string;
  uses?: string;
  with?: Record<string, unknown>;
  permissions?: Permissions;
  "runs-on"?: string;
  "timeout-minutes"?: number;
  "continue-on-error"?: boolean;
  environment?: string | { name: string; url?: string };
  concurrency?: { group: string; "cancel-in-progress"?: boolean | string };
  outputs?: Record<string, string>;
  env?: Record<string, string>;
  strategy?: { "fail-fast"?: boolean; matrix?: { include?: Record<string, unknown>[] } };
  steps?: Step[];
}

export interface Workflow {
  name?: string;
  on: Record<string, unknown>;
  permissions?: Permissions;
  concurrency?: { group: string; "cancel-in-progress"?: boolean | string };
  env?: Record<string, string>;
  jobs: Record<string, Job>;
}

export interface WorkflowFile {
  /** File name, such as `ci.yml`. */
  file: string;
  /** Where it was read from, relative to the repository root, for messages. */
  where: string;
  text: string;
  doc: Workflow;
}

export const WORKFLOWS_DIR = join(REPO_ROOT, ".github", "workflows");

export const readText = (...parts: string[]): string =>
  readFileSync(join(REPO_ROOT, ...parts), "utf8");

export const readJson = <T>(...parts: string[]): T => JSON.parse(readText(...parts)) as T;

export const readYaml = <T>(...parts: string[]): T => parse(readText(...parts)) as T;

/** One workflow file as text and data. `dir` is relative to the repository root. */
export function readWorkflow(dir: string, file: string): WorkflowFile {
  const text = readText(dir, file);
  return { file, where: `${dir}/${file}`, text, doc: parse(text) as Workflow };
}

/** The workflows of this repository, `.github/workflows/*.yml`, sorted by name. */
export function repositoryWorkflows(): WorkflowFile[] {
  return readdirSync(WORKFLOWS_DIR)
    .filter((name) => name.endsWith(".yml"))
    .sort()
    .map((name) => readWorkflow(".github/workflows", name));
}

export function workflow(file: string): WorkflowFile {
  return readWorkflow(".github/workflows", file);
}

/** Every `uses:` line of a workflow's text: the reference and the comment after it (without `#`). */
export function usesLines(text: string): { ref: string; comment: string | null; line: number }[] {
  const found: { ref: string; comment: string | null; line: number }[] = [];
  text.split("\n").forEach((raw, index) => {
    const match = /^\s*(?:-\s+)?uses:\s*(\S+)(?:\s+#\s*(.*?))?\s*$/.exec(raw);
    if (match?.[1] !== undefined) {
      found.push({ ref: match[1], comment: match[2] ?? null, line: index + 1 });
    }
  });
  return found;
}

/** The scopes of a permissions map that are `write`, sorted. A missing map has none. */
export function writeScopes(permissions: Permissions | undefined): string[] {
  return Object.entries(permissions ?? {})
    .filter(([, level]) => level === "write")
    .map(([scope]) => scope)
    .sort();
}

/** The `run:` script of the step with this name in this job; throws, naming what exists, when there is none. */
export function runOf(wf: WorkflowFile, jobId: string, stepName: string): string {
  const steps = wf.doc.jobs[jobId]?.steps ?? [];
  const step = steps.find((candidate) => candidate.name === stepName);
  if (step?.run === undefined) {
    const names = steps.map((candidate) => candidate.name ?? "(unnamed)").join(", ");
    throw new Error(`${wf.where}: no run step "${stepName}" in job ${jobId} (steps: ${names})`);
  }
  return step.run;
}

/** The text of the `on:` triggers, as the names of the events. */
export function eventsOf(wf: WorkflowFile): string[] {
  return Object.keys(wf.doc.on).sort();
}

// ---- the callers of a consuming repository ----------------------------------------------------------

/** The values `init` substitutes into scaffold/*.yml. */
export interface ScaffoldValues {
  docs: string;
  site: string;
  sha: string;
  version: string;
}

/** The values of the example repository (examples/basic): the placeholder commit of section 9.8. */
export const EXAMPLE_VALUES: ScaffoldValues = {
  docs: "docs",
  site: "docs-site",
  sha: "0".repeat(40),
  version: "v0.0.0",
};

/**
 * Renders a scaffold template the way `init` does, with the four tokens of SEED/scaffold. This is a
 * deliberately independent, three-line version of WP6's `renderScaffold`: the test compares what the
 * scaffold produces with what the example holds, and must not depend on the code it checks.
 */
export function renderTokens(template: string, values: ScaffoldValues): string {
  return template
    .replaceAll("@@DOCS@@", values.docs)
    .replaceAll("@@SITE@@", values.site)
    .replaceAll("@@SHA@@", values.sha)
    .replaceAll("@@VERSION@@", values.version);
}

export const CALLER_FILES = ["docs.yml", "docs-publish.yml"] as const;
export type CallerFile = (typeof CALLER_FILES)[number];

export interface CallerSet {
  label: string;
  /** The text of each caller workflow, as it would sit in `.github/workflows/` of a repository. */
  files: Record<CallerFile, string>;
}

const FIXTURES = join("test", "workflows", "fixtures");

const exists = (...parts: string[]): boolean => existsSync(join(REPO_ROOT, ...parts));

function readFiles(dir: string, render?: ScaffoldValues): Record<CallerFile, string> {
  const read = (file: CallerFile): string => {
    const text = readText(dir, file);
    return render === undefined ? text : renderTokens(text, render);
  };
  return { "docs.yml": read("docs.yml"), "docs-publish.yml": read("docs-publish.yml") };
}

/**
 * The caller workflows to check: the fixtures (copies of SEED/example-shell and SEED/scaffold, which
 * stand in for the packages that own the real ones) always; `scaffold/` rendered with the example's
 * values (WP6), `examples/basic/.github/workflows` (WP9) and this repository's own dogfood callers
 * (WP12) as soon as they exist. Each is held to the same invariants.
 */
export function callerSets(): CallerSet[] {
  const sets: CallerSet[] = [
    {
      label: "fixture: the example shell",
      files: readFiles(join(FIXTURES, "example-shell", ".github", "workflows")),
    },
    {
      label: "fixture: the scaffold, rendered",
      files: readFiles(join(FIXTURES, "scaffold"), EXAMPLE_VALUES),
    },
  ];
  if (exists("scaffold", "docs.yml") && exists("scaffold", "docs-publish.yml")) {
    sets.push({ label: "scaffold/ (WP6), rendered", files: readFiles("scaffold", EXAMPLE_VALUES) });
  }
  const example = join("examples", "basic", ".github", "workflows");
  if (exists(example, "docs.yml") && exists(example, "docs-publish.yml")) {
    sets.push({ label: "examples/basic (WP9)", files: readFiles(example) });
  }
  if (
    exists(".github", "workflows", "docs.yml") &&
    exists(".github", "workflows", "docs-publish.yml")
  ) {
    sets.push({ label: "dogfood callers (WP12)", files: readFiles(join(".github", "workflows")) });
  }
  return sets;
}

/** Parses a caller's text. */
export const parseCaller = (text: string): Workflow => parse(text) as Workflow;
