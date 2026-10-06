// The release pipeline (section 8.2 of the architecture decision record): release.yml, the
// release-please configuration it reads, and the pull request title rule that keeps release-please
// from silently skipping a commit.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv } from "ajv";
import { describe, expect, test } from "vitest";
import { TYPES } from "../../scripts/check-pr-title.mjs";
import { tempDir } from "../support/index.js";
import { hasBash, readJson, readText, runOf, workflow, type Step } from "./helpers.js";

const release = workflow("release.yml");
const jobs = release.doc.jobs;
const publish = jobs.publish;
const please = jobs["release-please"];

const stepWith = (steps: Step[] | undefined, prefix: string): Step | undefined =>
  steps?.find((step) => step.uses?.startsWith(prefix));

describe("release.yml", () => {
  test("runs on pushes to main, daily (a Dependabot merge made with GITHUB_TOKEN starts no push workflow) and by hand", () => {
    expect(Object.keys(release.doc.on).sort()).toEqual(["push", "schedule", "workflow_dispatch"]);
    expect(release.doc.on.push).toEqual({ branches: ["main"] });
    expect(release.doc.on.schedule).toEqual([{ cron: "17 5 * * *" }]);
    expect(release.doc.concurrency).toEqual({ group: "release", "cancel-in-progress": false });
  });

  test("has two jobs, the release pull request and the publish, and no job that moves a tag", () => {
    expect(Object.keys(jobs)).toEqual(["release-please", "publish"]);
  });

  test("release-please holds the three write permissions it needs, and exposes the release to the publish job", () => {
    expect(please?.permissions).toEqual({
      contents: "write",
      "pull-requests": "write",
      actions: "write",
    });
    expect(Object.keys(please?.outputs ?? {}).sort()).toEqual([
      "release-created",
      "sha",
      "tag-name",
      "version",
    ]);
    const action = stepWith(please?.steps, "googleapis/release-please-action@");
    expect(action?.with).toEqual({
      token: "${{ secrets.GITHUB_TOKEN }}",
      "config-file": "release-please-config.json",
      "manifest-file": ".release-please-manifest.json",
    });
  });

  test("dispatches ci.yml on the release branch, because a pull request opened with GITHUB_TOKEN starts no checks", () => {
    const dispatch = please?.steps?.find(
      (step) => step.name === "Run CI on the release pull request",
    );
    expect(dispatch?.if).toBe("${{ steps.rp.outputs.prs_created == 'true' }}");
    expect(dispatch?.run).toContain('gh workflow run ci.yml --ref "$branch"');
    expect(dispatch?.env?.RELEASE_PR).toBe("${{ steps.rp.outputs.pr }}");
    expect(workflow("ci.yml").doc.on).toHaveProperty("workflow_dispatch");
  });

  test("publish needs the release, runs only when one was created, in the npm environment, with OIDC and nothing else", () => {
    expect(publish?.needs).toBe("release-please");
    expect(publish?.if).toBe("${{ needs.release-please.outputs.release-created == 'true' }}");
    expect(publish?.environment).toBe("npm");
    expect(publish?.permissions).toEqual({ contents: "read", "id-token": "write" });
  });

  test("publish checks out the release commit and installs, checks, builds and checks the pack before publishing", () => {
    const steps = publish?.steps ?? [];
    expect(stepWith(steps, "actions/checkout@")?.with).toEqual({
      ref: "${{ needs.release-please.outputs.sha }}",
      "persist-credentials": false,
    });
    expect(stepWith(steps, "actions/setup-node@")?.with).toEqual({
      "node-version": "24",
      "registry-url": "https://registry.npmjs.org",
      "package-manager-cache": false,
    });
    const build = steps.find(
      (step) => step.name === "Install, check and build at the release commit",
    );
    expect(build?.run?.trimEnd().split("\n")).toEqual([
      "npm ci --ignore-scripts --no-audit --no-fund",
      "npm run check",
      "npm run build",
      "npm run check:pack",
    ]);
    const order = steps.map((step) => step.name);
    expect(order.indexOf("Install, check and build at the release commit")).toBeLessThan(
      order.indexOf("Publish (skipped when the version already exists)"),
    );
  });

  test("the publish step signs with provenance, is safe to re-run, and keeps NPM_TOKEN wired for route A only", () => {
    const step = publish?.steps?.find(
      (candidate) => candidate.name === "Publish (skipped when the version already exists)",
    );
    expect(step?.env).toEqual({
      VERSION: "${{ needs.release-please.outputs.version }}",
      NODE_AUTH_TOKEN: "${{ secrets.NPM_TOKEN }}",
    });
    const script = step?.run ?? "";
    expect(script).toContain("npm publish --provenance --access public");
    expect(script).toContain('npm view "$name@$VERSION" version');
    expect(script).toContain("is already on npm; nothing to publish");
    // A package.json that disagrees with release-please is refused before anything is published.
    expect(script.indexOf('"$have" != "$VERSION"')).toBeGreaterThan(-1);
    expect(script.indexOf('"$have" != "$VERSION"')).toBeLessThan(script.indexOf("npm publish"));
  });

  test("publishing sits in the same file as release-please: npm trusted publishing names the workflow file", () => {
    const text = release.text;
    expect(text).toContain("googleapis/release-please-action@");
    expect(text).toContain("npm publish");
  });
});

describe("release-please configuration", () => {
  type Config = Record<string, unknown> & {
    packages: Record<string, Record<string, unknown>>;
    "changelog-sections": { type: string; section: string; hidden?: boolean }[];
  };
  const config = readJson<Config>("release-please-config.json");
  const manifest = readJson<Record<string, string>>(".release-please-manifest.json");
  const pkg = readJson<{ name: string; version: string }>("package.json");

  test("validates against release-please's own JSON schema", () => {
    const schema = readJson<object>(
      "test",
      "workflows",
      "fixtures",
      "release-please-config.schema.json",
    );
    // The schema's `uri-reference` format is a hint; format checks are off, the structure is checked.
    const validate = new Ajv({ allErrors: true, strict: false, validateFormats: false }).compile(
      schema,
    );
    expect(validate(config), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...config, "bump-minor-premajor": true }), "a typo must be refused").toBe(
      false,
    );
  });

  test("is manifest mode with one package at the root: node, @avunu/docusystem", () => {
    expect(Object.keys(config.packages)).toEqual(["."]);
    expect(config.packages["."]).toEqual({ "release-type": "node", "package-name": pkg.name });
    expect(Object.keys(manifest)).toEqual(["."]);
    // release-please keeps the two in step; the first release moves both from 0.0.0 to 0.1.0.
    expect(manifest["."]).toBe(pkg.version);
    expect(manifest["."]).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("tags and releases are named vX.Y.Z, the release pull request is `chore: release vX.Y.Z`", () => {
    expect(config["include-v-in-tag"]).toBe(true);
    expect(config["include-component-in-tag"]).toBe(false);
    expect(config["pull-request-title-pattern"]).toBe("chore: release v${version}");
  });

  test("starts at 0.1.0 and stays below 1.0 until a commit says Release-As: 1.0.0", () => {
    expect(config["initial-version"]).toBe("0.1.0");
    expect(config["bump-minor-pre-major"]).toBe(true);
    expect(config["bump-patch-for-minor-pre-major"]).toBe(false);
    expect(config["release-as"]).toBeUndefined();
  });

  test("only feat, fix, perf and revert (and breaking changes) release; the other types are hidden", () => {
    const sections = new Map(config["changelog-sections"].map((s) => [s.type, s]));
    const visible = [...sections.values()].filter((s) => s.hidden !== true).map((s) => s.type);
    const hidden = [...sections.values()].filter((s) => s.hidden === true).map((s) => s.type);
    expect(visible).toEqual(["feat", "fix", "perf", "revert"]);
    expect(hidden).toEqual(["docs", "style", "refactor", "test", "build", "ci", "chore"]);
  });

  test("classifies every Conventional Commit type the pull request title check accepts, and nothing else", () => {
    const types = config["changelog-sections"].map((s) => s.type).sort();
    expect(types).toEqual([...TYPES].sort());
  });

  test("the workflow reads the files that exist", () => {
    const action = stepWith(please?.steps, "googleapis/release-please-action@");
    expect(action?.with?.["config-file"]).toBe("release-please-config.json");
    expect(action?.with?.["manifest-file"]).toBe(".release-please-manifest.json");
  });
});

// The trusted publisher on npmjs.com cannot be read from a pull request (`npm trust list` needs
// interactive two-factor authentication), and when its record does not match the run, npm 11 reports
// only ENEEDAUTH at its default log level. These tests keep the two things that can be kept in this
// repository: the publish step explains a refusal, and the record the runbook asks for is the one this
// workflow presents.
describe("a refused trusted publisher explains itself", () => {
  const PUBLISH_STEP = "Publish (skipped when the version already exists)";
  const script = runOf(release, "publish", PUBLISH_STEP);

  /** Runs the publish step's script with a recording stand-in for npm; `publishStatus` is what `npm publish` exits with. */
  function runPublish(o: { onNpm: boolean; publishStatus: number }) {
    const dir = tempDir();
    const bin = join(dir, "bin");
    const calls = join(dir, "calls.txt");
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "@avunu/docusystem", version: "0.1.0" }),
    );
    // `npm view` exits 0 when the version is on npm; `npm publish` exits as told, with npm's own words on a refusal.
    const fake = [
      "#!/bin/sh",
      'echo "$*" >> "$CALLS"',
      'case "$1" in',
      `  view) exit ${o.onNpm ? 0 : 1} ;;`,
      "  publish)",
      `    if [ ${o.publishStatus} -ne 0 ]; then`,
      '      echo "npm error code ENEEDAUTH" >&2',
      '      echo "npm error need auth This command requires you to be logged in to https://registry.npmjs.org/" >&2',
      "    fi",
      `    exit ${o.publishStatus} ;;`,
      "esac",
      "",
    ].join("\n");
    const npm = join(bin, "npm");
    mkdirSync(bin);
    writeFileSync(npm, fake);
    chmodSync(npm, 0o755);
    const result = spawnSync(
      "bash",
      ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", script],
      {
        cwd: dir,
        env: {
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          VERSION: "0.1.0",
          CALLS: calls,
        },
        encoding: "utf8",
      },
    );
    const recorded = existsSync(calls) ? readFileSync(calls, "utf8") : "";
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      calls: recorded.split("\n").filter((line) => line !== ""),
    };
  }

  test.skipIf(!hasBash)(
    "npm publish runs at the verbose level (where npm prints the registry's reason), npm view does not",
    () => {
      const { status, calls } = runPublish({ onNpm: false, publishStatus: 0 });
      expect(status).toBe(0);
      expect(calls).toEqual([
        "view @avunu/docusystem@0.1.0 version",
        "publish --provenance --access public --loglevel verbose",
      ]);
    },
  );

  test.skipIf(!hasBash)(
    "a failed publish fails the step and says where to look: the verbose oidc line, the record, the runbook",
    () => {
      const { status, stdout, stderr } = runPublish({ onNpm: false, publishStatus: 1 });
      expect(status).toBe(1);
      // npm's own output is untouched.
      expect(stderr).toContain("ENEEDAUTH");
      const annotations = stdout.split("\n").filter((line) => line.startsWith("::error"));
      expect(annotations).toHaveLength(1);
      const message = annotations[0] ?? "";
      // One line (a workflow command ends at a line break), with a title.
      expect(message).toMatch(/^::error title=[^:,]+::/);
      expect(message).toContain("ENEEDAUTH");
      expect(message).toContain("npm verbose oidc");
      expect(message).toContain("release.yml");
      expect(message).toContain("environment npm");
      expect(message).toContain("permission publish");
      expect(message).toContain("MAINTAINING.md");
    },
  );

  test.skipIf(!hasBash)(
    "a version that is already on npm is not published, and raises no error",
    () => {
      const { status, stdout, calls } = runPublish({ onNpm: true, publishStatus: 1 });
      expect(status).toBe(0);
      expect(stdout).toContain("is already on npm; nothing to publish");
      expect(stdout).not.toContain("::error");
      expect(calls).toEqual(["view @avunu/docusystem@0.1.0 version"]);
    },
  );

  test("the runbook's `npm trust github` command is the record this run presents to npm", () => {
    // What npm checks, from the OIDC token of the publish job: the repository, the workflow file name
    // and the GitHub environment (the claims `repository`, `workflow_ref` and `environment`).
    const pkg = readJson<{ repository: { url: string } }>("package.json");
    const repository = /github\.com[/:](.+?)(?:\.git)?$/.exec(pkg.repository.url)?.[1];
    const environment = publish?.environment;
    expect(repository).toBe("Avunu/docusystem");
    expect(environment).toBe("npm");
    const runbook = readText("MAINTAINING.md");
    const command = /^\s*npm trust github (\S+) (.*)$/m.exec(runbook);
    expect(command, "MAINTAINING.md has the npm trust github command").not.toBeNull();
    const flags = (command?.[2] ?? "").split(/\s+/);
    const value = (flag: string): string | undefined => flags[flags.indexOf(flag) + 1];
    expect(command?.[1]).toBe("@avunu/docusystem");
    expect(value("--repo")).toBe(repository);
    expect(value("--file")).toBe(release.file);
    expect(value("--env")).toBe(environment);
    // A direct `npm publish` needs the `publish` permission; `stage publish` alone refuses it.
    expect(flags).toContain("--allow-publish");
    expect(script).toContain("npm publish ");
    expect(script).not.toContain("npm stage");
  });
});
