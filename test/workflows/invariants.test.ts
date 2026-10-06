// What must hold for every workflow of this repository, whatever it does (section 4.4, 5.4, 8.2 and 9.8
// of the architecture decision record): least privilege, pinned actions, nothing from a pull request
// reaching a shell by interpolation, nothing running at install time.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { REPO_ROOT } from "../support/index.js";
import {
  eventsOf,
  readJson,
  readText,
  readYaml,
  repositoryWorkflows,
  usesLines,
  writeScopes,
  type WorkflowFile,
} from "./helpers.js";

// docs.yml and docs-publish.yml are the dogfood callers (WP12): they are held to the caller invariants
// of callers.test.ts, not to the table of this file.
const CALLERS = new Set(["docs.yml", "docs-publish.yml"]);
const workflows = repositoryWorkflows().filter((wf) => !CALLERS.has(wf.file));

/** The events each workflow of this repository starts on. */
const EVENTS: Record<string, string[]> = {
  "catalog.yml": ["schedule", "workflow_dispatch"],
  "ci.yml": ["pull_request", "push", "workflow_dispatch"],
  "docs-build.yml": ["workflow_call"],
  "docs-deploy.yml": ["workflow_call"],
  "fleet.yml": ["schedule", "workflow_dispatch"],
  "jx-latest.yml": ["schedule", "workflow_dispatch"],
  "release.yml": ["push", "schedule", "workflow_dispatch"],
};

/** The only jobs that hold a write permission, and which. Everything else is read-only or has none. */
const WRITES: Record<string, string[]> = {
  "catalog.yml#refresh": ["actions", "contents", "pull-requests"],
  "docs-deploy.yml#deploy": ["id-token", "pages"],
  "jx-latest.yml#report": ["issues"],
  "release.yml#publish": ["id-token"],
  "release.yml#release-please": ["actions", "contents", "pull-requests"],
};

/** The scripts a workflow may run: this package's (3.1) and the ones other work packages own. */
const SCRIPTS = new Set([
  "check-pack.mjs",
  "check-pr-title.mjs",
  "sync-catalog.mjs",
  "test-pack.mjs",
  "assert-dist.mjs",
  "compare-dist.mjs",
  "fleet.mjs",
]);

const runScripts = (wf: WorkflowFile): { job: string; step: string; run: string }[] =>
  Object.entries(wf.doc.jobs).flatMap(([job, body]) =>
    (body.steps ?? []).flatMap((step) =>
      step.run === undefined ? [] : [{ job, step: step.name ?? "(unnamed)", run: step.run }],
    ),
  );

describe("the workflows of this repository", () => {
  test("are exactly the ones of section 3.1 (the dogfood callers aside)", () => {
    expect(workflows.map((wf) => wf.file)).toEqual(Object.keys(EVENTS));
  });

  test.each(workflows.map((wf) => [wf.file, wf] as const))(
    "%s: starts only on its own events",
    (_file, wf) => {
      expect(eventsOf(wf)).toEqual(EVENTS[wf.file]);
    },
  );

  test.each(workflows.map((wf) => [wf.file, wf] as const))(
    "%s: is never triggered by pull_request_target or workflow_run, and never inherits secrets",
    (_file, wf) => {
      expect(eventsOf(wf)).not.toContain("pull_request_target");
      expect(eventsOf(wf)).not.toContain("workflow_run");
      // The parsed document, so that a comment explaining the rule does not trip it.
      expect(JSON.stringify(wf.doc)).not.toMatch(
        /pull_request_target|workflow_run|"secrets":"inherit"/,
      );
    },
  );

  test.each(workflows.map((wf) => [wf.file, wf] as const))(
    "%s: grants nothing at the top",
    (_file, wf) => {
      expect(wf.doc.permissions).toEqual({});
    },
  );

  test.each(workflows.map((wf) => [wf.file, wf] as const))(
    "%s: every job is named, has a timeout, and asks for the narrowest permissions",
    (_file, wf) => {
      for (const [id, job] of Object.entries(wf.doc.jobs)) {
        const where = `${wf.file}#${id}`;
        expect(job.name, `${where} name`).toBeTruthy();
        if (job.uses === undefined) {
          expect(job["timeout-minutes"], `${where} timeout-minutes`).toBeGreaterThan(0);
        }
        expect(job.permissions, `${where} permissions`).toBeDefined();
        // Only scopes this repository's jobs are known to need, and read access only unless the table says so.
        for (const [scope, level] of Object.entries(job.permissions ?? {})) {
          expect(["read", "write"], `${where} ${scope}`).toContain(level);
        }
        expect(writeScopes(job.permissions), `${where} write scopes`).toEqual(WRITES[where] ?? []);
      }
    },
  );

  test("id-token: write exists only where a token is exchanged: npm publishing and GitHub Pages", () => {
    const holders = workflows.flatMap((wf) =>
      Object.entries(wf.doc.jobs)
        .filter(([, job]) => job.permissions?.["id-token"] === "write")
        .map(([id]) => `${wf.file}#${id}`),
    );
    expect(holders.sort()).toEqual(["docs-deploy.yml#deploy", "release.yml#publish"]);
  });

  test.each(workflows.map((wf) => [wf.file, wf] as const))(
    "%s: every action is pinned to a full commit with a version comment",
    (_file, wf) => {
      for (const { ref, comment, line } of usesLines(wf.text)) {
        if (ref.startsWith("./")) continue;
        expect(ref, `${wf.where}:${line}`).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
        expect(comment, `${wf.where}:${line} version comment`).toMatch(/^v\d+\.\d+\.\d+$/);
      }
    },
  );

  test.each(workflows.map((wf) => [wf.file, wf] as const))(
    "%s: checkouts keep no credentials and Node setups restore no cache",
    (_file, wf) => {
      for (const [id, job] of Object.entries(wf.doc.jobs)) {
        for (const step of job.steps ?? []) {
          const where = `${wf.file}#${id}: ${step.name ?? step.uses ?? "step"}`;
          if (step.uses?.startsWith("actions/checkout@")) {
            expect(step.with?.["persist-credentials"], where).toBe(false);
          }
          if (step.uses?.startsWith("actions/setup-node@")) {
            expect(step.with?.["package-manager-cache"], where).toBe(false);
          }
        }
      }
    },
  );

  test.each(workflows.map((wf) => [wf.file, wf] as const))(
    "%s: nothing is interpolated into a shell script: values reach it through env",
    (_file, wf) => {
      for (const { job, step, run } of runScripts(wf)) {
        expect(run, `${wf.file}#${job}: ${step}`).not.toContain("${{");
      }
    },
  );

  test.each(workflows.map((wf) => [wf.file, wf] as const))(
    "%s: installs with the lockfile frozen and no scripts, and never fetches the CLI with npx or bunx",
    (_file, wf) => {
      for (const { job, step, run } of runScripts(wf)) {
        const where = `${wf.file}#${job}: ${step}`;
        for (const line of run.split("\n")) {
          const command = line.trim();
          if (/^npm (?:ci|install|i)\b/.test(command)) {
            expect(command, where).toContain("--ignore-scripts");
            // An install outside the lockfile is for jx-latest.yml alone, which saves nothing.
            if (!command.startsWith("npm ci")) {
              expect(wf.file, where).toBe("jx-latest.yml");
              expect(command, where).toContain("--no-save");
            }
          }
          expect(line, where).not.toMatch(/\b(?:npx|bunx)\b.*docusystem/);
        }
      }
    },
  );

  test("run only scripts the decision record names, and the ones owned here exist", () => {
    const pkg = readJson<{ scripts: Record<string, string> }>("package.json");
    for (const wf of workflows) {
      for (const { job, step, run } of runScripts(wf)) {
        const where = `${wf.file}#${job}: ${step}`;
        for (const [, name] of run.matchAll(/\bscripts\/([\w.-]+\.mjs)\b/g)) {
          expect(SCRIPTS, `${where}: scripts/${name}`).toContain(name);
          if (name === "check-pack.mjs" || name === "check-pr-title.mjs") {
            expect(existsSync(join(REPO_ROOT, "scripts", name)), `scripts/${name} exists`).toBe(
              true,
            );
          }
        }
        for (const [, name] of run.matchAll(/^\s*npm run ([\w:-]+)/gm)) {
          expect(pkg.scripts, `${where}: npm run ${name}`).toHaveProperty(name as string);
        }
      }
    }
  });

  test("a workflow publishes to npm only in release.yml", () => {
    const publishers = workflows
      .filter((wf) => /\bnpm publish\b/.test(wf.text))
      .map((wf) => wf.file);
    expect(publishers).toEqual(["release.yml"]);
  });

  test("no workflow creates or moves a tag: callers pin a commit and there is no major tag", () => {
    for (const wf of workflows) {
      expect(wf.text, wf.file).not.toMatch(
        /git tag\b|git push[^\n]*--tags|git\/refs\/tags|refs\/tags\//,
      );
      expect(Object.keys(wf.doc.jobs).join(" "), wf.file).not.toMatch(/tag/);
    }
  });
});

describe("the files around the workflows", () => {
  test("zizmor requires a commit hash for every action, the reusable workflows of this repository included", () => {
    const config = readYaml<{
      rules: { "unpinned-uses": { config: { policies: Record<string, string> } } };
    }>(".github", "zizmor.yml");
    expect(config.rules["unpinned-uses"].config.policies).toEqual({ "*": "hash-pin" });
  });

  test("CODEOWNERS puts the release pipeline and the reusable workflows under a maintainer", () => {
    const owners = readText(".github", "CODEOWNERS");
    for (const path of [
      "/.github/",
      "/release-please-config.json",
      "/.release-please-manifest.json",
      "/package.json",
    ]) {
      expect(owners, path).toMatch(
        new RegExp(`^${path.replaceAll(/[./]/g, String.raw`\$&`)}\\s+@\\S+`, "m"),
      );
    }
    expect(owners).toMatch(/^\*\s+@\S+/m);
  });

  test("the issue templates are valid and send vulnerability reports to private reporting", () => {
    const bug = readYaml<{ name: string; description: string; body: unknown[] }>(
      ".github",
      "ISSUE_TEMPLATE",
      "bug_report.yml",
    );
    const feature = readYaml<{ name: string; description: string; body: unknown[] }>(
      ".github",
      "ISSUE_TEMPLATE",
      "feature_request.yml",
    );
    for (const template of [bug, feature]) {
      expect(template.name).toBeTruthy();
      expect(template.description).toBeTruthy();
      expect(template.body.length).toBeGreaterThan(0);
    }
    const config = readYaml<{ blank_issues_enabled: boolean; contact_links: { url: string }[] }>(
      ".github",
      "ISSUE_TEMPLATE",
      "config.yml",
    );
    expect(config.blank_issues_enabled).toBe(false);
    expect(config.contact_links.map((link) => link.url)).toContain(
      "https://github.com/Avunu/docusystem/security/advisories/new",
    );
  });

  test("the pull request template asks for the checks and for breaking changes", () => {
    const template = readText(".github", "PULL_REQUEST_TEMPLATE.md");
    expect(template).toContain("npm run check");
    expect(template).toContain("npm run check:pack");
    expect(template).toMatch(/Breaking for consumers/);
  });
});
