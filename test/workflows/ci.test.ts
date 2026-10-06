// ci.yml (sections 5.4, 9.4 and 9.8 of the architecture decision record): the one required check, the
// consumer matrix, the workflow lint pins, and the dispatch trigger the release and catalog pull
// requests depend on.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { REPO_ROOT, tempDir } from "../support/index.js";
import { hasBash, hasJq, runOf, workflow } from "./helpers.js";

const ci = workflow("ci.yml");
const jobs = ci.doc.jobs;

const needsOf = (id: string): string[] => {
  const needs = jobs[id]?.needs;
  return needs === undefined ? [] : Array.isArray(needs) ? needs : [needs];
};

describe("ci.yml", () => {
  test("starts on pull requests, pushes to main and by hand (the release and catalog branches need the last)", () => {
    expect(Object.keys(ci.doc.on).sort()).toEqual(["pull_request", "push", "workflow_dispatch"]);
    expect(ci.doc.on.push).toEqual({ branches: ["main"] });
    expect(ci.doc.permissions).toEqual({});
  });

  test("has the jobs of section 5.4, plus the informational Windows row", () => {
    expect(Object.keys(jobs).sort()).toEqual([
      "check",
      "ci",
      "consumers",
      "fleet",
      "pack",
      "pr-title",
      "verify",
      "windows",
      "workflows",
    ]);
  });

  test("`ci` is the one required check: it waits for every job except the informational one and runs always", () => {
    expect(jobs.ci?.name).toBe("ci");
    expect(jobs.ci?.if).toBe("${{ always() }}");
    expect(jobs.ci?.permissions).toEqual({});
    const waitedFor = needsOf("ci").sort();
    const others = Object.keys(jobs)
      .filter((id) => id !== "ci" && id !== "windows")
      .sort();
    expect(waitedFor).toEqual(others);
    expect(waitedFor).not.toContain("windows");
  });

  test.skipIf(!hasJq)(
    "the `ci` script passes on success and skipped, and fails on failure and cancellation",
    () => {
      const script = runOf(ci, "ci", "Every job passed (a skipped one is fine)");
      const decide = (results: Record<string, string>): number | null => {
        const needs = Object.fromEntries(
          Object.entries(results).map(([id, result]) => [id, { result }]),
        );
        return spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", script], {
          env: { PATH: process.env.PATH ?? "", RESULTS: JSON.stringify(needs) },
          encoding: "utf8",
        }).status;
      };
      expect(decide({ check: "success", fleet: "skipped", "pr-title": "skipped" })).toBe(0);
      expect(decide({ check: "success", pack: "failure" })).toBe(1);
      expect(decide({ check: "success", pack: "cancelled" })).toBe(1);
      expect(decide({ check: "failure", fleet: "skipped" })).toBe(1);
    },
  );

  test("the Windows row is informational: unit tests only, on Node 24, and it can never fail the run", () => {
    const windows = jobs.windows;
    expect(windows?.["runs-on"]).toBe("windows-latest");
    expect(windows?.["continue-on-error"]).toBe(true);
    const node = windows?.steps?.find((step) => step.uses?.startsWith("actions/setup-node@"));
    expect(node?.with).toMatchObject({ "node-version": "24" });
    expect(windows?.steps?.map((step) => step.run)).toContain("npm test -- --project unit");
  });

  test("the fleet job runs only on a release pull request (a release-please branch)", () => {
    expect(jobs.fleet?.if).toBe(
      "${{ startsWith(github.head_ref || github.ref_name, 'release-please--') }}",
    );
    expect(jobs.fleet?.steps?.map((step) => step.run)).toContain("node scripts/fleet.mjs");
  });

  test("the pull request title is checked on pull requests only, and reaches the script through env", () => {
    expect(jobs["pr-title"]?.if).toBe("${{ github.event_name == 'pull_request' }}");
    const step = jobs["pr-title"]?.steps?.find(
      (candidate) => candidate.run === "node scripts/check-pr-title.mjs",
    );
    expect(step?.env).toEqual({
      PR_TITLE: "${{ github.event.pull_request.title }}",
      PR_BODY: "${{ github.event.pull_request.body }}",
    });
  });

  test("a pull request run cancels the one it replaces; a push or dispatch run never cancels", () => {
    expect(ci.doc.concurrency).toEqual({
      group: "ci-${{ github.event.pull_request.number || github.ref }}",
      "cancel-in-progress": "${{ github.event_name == 'pull_request' }}",
    });
  });
});

describe("the consumer matrix (section 9.4)", () => {
  const rows = (jobs.consumers?.strategy?.matrix?.include ?? []) as Record<
    string,
    string | boolean
  >[];
  const pick = (row: Record<string, string | boolean>) =>
    [row.os, row.node, row.pm, row.runtime, row.linker].join(" ");

  test("is the eight required rows, in the order of the table", () => {
    expect(rows.map(pick)).toEqual([
      "ubuntu-latest 22 npm node hoisted",
      "ubuntu-latest 24 npm node hoisted",
      "ubuntu-latest 26 npm node hoisted",
      "ubuntu-latest 24 bun bun hoisted",
      "ubuntu-latest 24 bun bun isolated",
      "ubuntu-latest 24 bun node isolated",
      "macos-latest 24 npm node hoisted",
      "macos-latest 24 bun bun hoisted",
    ]);
  });

  test("keeps going when one row fails, and only row 2 also runs the workspace layout", () => {
    expect(jobs.consumers?.strategy?.["fail-fast"]).toBe(false);
    expect(rows.map((row) => row.workspace === true)).toEqual([
      false,
      true,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
    const workspace = jobs.consumers?.steps?.find((step) => step.if === "${{ matrix.workspace }}");
    expect(workspace?.run).toBe(
      'node scripts/test-pack.mjs --pm "$PM" --runtime "$RUNTIME" --linker "$LINKER" --workspace',
    );
  });

  test("builds the tarball with Node 24 whatever the row, then switches to the row's Node", () => {
    const setups = (jobs.consumers?.steps ?? []).filter((step) =>
      step.uses?.startsWith("actions/setup-node@"),
    );
    expect(setups.map((step) => step.with?.["node-version"])).toEqual(["24", "${{ matrix.node }}"]);
    const names = (jobs.consumers?.steps ?? []).map((step) => step.name);
    expect(names.indexOf("Build")).toBeLessThan(names.indexOf("Switch to the row's Node.js"));
  });

  test("sets Bun up for every row that uses it as installer or runtime, and pins its minor", () => {
    const bun = jobs.consumers?.steps?.find((step) => step.uses?.startsWith("oven-sh/setup-bun@"));
    expect(bun?.if).toBe("${{ matrix.pm == 'bun' || matrix.runtime == 'bun' }}");
    expect(bun?.with).toMatchObject({ "bun-version": "1.4", "no-cache": true });
  });

  test("passes the row to test-pack.mjs through the environment", () => {
    const step = jobs.consumers?.steps?.find((candidate) =>
      candidate.run?.startsWith("node scripts/test-pack.mjs --pm"),
    );
    expect(step?.env).toEqual({
      PM: "${{ matrix.pm }}",
      RUNTIME: "${{ matrix.runtime }}",
      LINKER: "${{ matrix.linker }}",
    });
    expect(step?.run).toBe(
      'node scripts/test-pack.mjs --pm "$PM" --runtime "$RUNTIME" --linker "$LINKER"',
    );
  });
});

describe("the workflow lint (section 9.8)", () => {
  const lint = jobs.workflows;

  test("downloads actionlint 1.7.12 and verifies its sha256 before it runs", () => {
    const step = lint?.steps?.find((candidate) => candidate.name === "Install actionlint");
    expect(step?.env?.ACTIONLINT_VERSION).toBe("1.7.12");
    expect(step?.env?.ACTIONLINT_SHA256).toMatch(/^[0-9a-f]{64}$/);
    const script = step?.run ?? "";
    expect(script.indexOf("sha256sum --check --strict")).toBeGreaterThan(script.indexOf("curl "));
    expect(script.indexOf("sha256sum --check --strict")).toBeLessThan(script.indexOf("tar "));
  });

  test("lints this repository's workflows, and the example's callers wherever the example exists, with actionlint", () => {
    expect(runOf(ci, "workflows", "actionlint")).toBe(
      "./actionlint -color .github/workflows/*.yml",
    );
    const example = lint?.steps?.find(
      (step) => step.name === "actionlint on the example's callers",
    );
    expect(example?.run).toBe("./actionlint -color examples/basic/.github/workflows/*.yml");
    expect(example?.if).toBe("${{ hashFiles('examples/basic/.github/workflows/*.yml') != '' }}");
  });

  test("runs zizmor 1.30.1, pedantic: online on this repository, offline on the example (placeholder commit)", () => {
    const zizmor = (lint?.steps ?? []).filter((step) =>
      step.uses?.startsWith("zizmorcore/zizmor-action@"),
    );
    expect(zizmor).toHaveLength(2);
    for (const step of zizmor) {
      expect(step.with).toMatchObject({
        version: "1.30.1",
        persona: "pedantic",
        "advanced-security": false,
      });
    }
    const [own, example] = zizmor;
    expect(String(own?.with?.inputs).split(/\s+/)).toEqual([
      ".github/workflows",
      ".github/dependabot.yml",
    ]);
    expect(own?.with?.["online-audits"]).toBeUndefined();
    expect(example?.with?.inputs).toBe("examples/basic/.github");
    expect(example?.with?.["online-audits"]).toBe(false);
    expect(example?.if).toBe("${{ hashFiles('examples/basic/.github/workflows/*.yml') != '' }}");
  });
});

describe("the other jobs", () => {
  test("check is format, lint, types and both test projects, then the build; pack is the allowlist, publint and attw", () => {
    const runs = (id: string) => (jobs[id]?.steps ?? []).map((step) => step.run).filter(Boolean);
    expect(runs("check")).toEqual([
      "npm ci --ignore-scripts --no-audit --no-fund",
      "npm run check",
      "npm run build",
      expect.stringContaining("npm test"),
    ]);
    expect(runs("pack")).toEqual([
      "npm ci --ignore-scripts --no-audit --no-fund",
      "npm run build",
      "npm run check:pack",
      "npm run check:publint",
      "npm run check:types",
    ]);
  });

  test("the tests run again at another version, after the check, so a test that pins the version fails on the pull request and not at the release", () => {
    // release.yml runs `npm run check` on the release commit, after release-please has moved the version
    // and created the tag: a failure there leaves a tag and a GitHub Release with nothing on npm.
    const names = (jobs.check?.steps ?? []).map((step) => step.name);
    expect(names.indexOf("Tests at another version")).toBeGreaterThan(names.indexOf("Check"));
    const lines = runOf(ci, "check", "Tests at another version")
      .split("\n")
      .filter((line) => line.trim() !== "");
    expect(lines.at(-1)).toBe("npm test");
    const bump = /^npm version (\d+\.\d+\.\d+) --no-git-tag-version --ignore-scripts$/.exec(
      lines[0] ?? "",
    );
    expect(bump, "the first line moves package.json and the lockfile").not.toBeNull();
    const next = bump?.[1] ?? "";

    // Run everything but the final `npm test` on copies of the three files release-please changes, as
    // they stand at a version that is not `next` (not the repository's own: this test runs at `next`
    // too), and compare with what a release pull request does to them (verified on the release branch
    // of v0.1.0: the version in all three, the manifest as `{ ".": "X.Y.Z" }`).
    if (!hasBash) return;
    const seed = "0.0.1";
    expect(next).not.toBe(seed);
    const dir = tempDir();
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
    const lock = JSON.parse(readFileSync(join(REPO_ROOT, "package-lock.json"), "utf8"));
    pkg.version = lock.version = lock.packages[""].version = seed;
    writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2));
    writeFileSync(join(dir, "package-lock.json"), JSON.stringify(lock, null, 2));
    writeFileSync(join(dir, ".release-please-manifest.json"), `{\n  ".": "${seed}"\n}\n`);
    const run = spawnSync(
      "bash",
      ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", lines.slice(0, -1).join("\n")],
      {
        cwd: dir,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? dir,
          npm_config_update_notifier: "false",
        },
        encoding: "utf8",
      },
    );
    expect(run.status, run.stderr).toBe(0);
    const json = (file: string) => JSON.parse(readFileSync(join(dir, file), "utf8"));
    expect(json("package.json").version).toBe(next);
    expect(json("package-lock.json").version).toBe(next);
    expect(json("package-lock.json").packages[""].version).toBe(next);
    expect(readFileSync(join(dir, ".release-please-manifest.json"), "utf8")).toBe(
      `{\n  ".": "${next}"\n}\n`,
    );
  });

  test("verify builds the example from the tarball, runs the browser suites in Chrome and keeps the screenshots", () => {
    const steps = jobs.verify?.steps ?? [];
    const scripts = steps.map((step) => step.run ?? "").join("\n");
    expect(scripts).toContain('node scripts/test-pack.mjs --keep "$RUNNER_TEMP/consumer"');
    expect(scripts).toContain("bun install --frozen-lockfile");
    for (const suite of ["axe.ts", "drawer.ts", "fences.ts", "switcher.ts", "shots.ts"]) {
      expect(scripts, suite).toContain(`bun ${suite}`);
    }
    const shots = steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
    expect(shots?.with).toMatchObject({ name: "verify-shots", "retention-days": 7 });
  });

  test("the switcher suite runs under a slug of the real catalog, as 9.5 requires", () => {
    const script = runOf(ci, "verify", "The project switcher, under a slug of the catalog");
    expect(script).toContain(`jq '.slug = "frappe-nix"'`);
    expect(script.indexOf("docusystem build")).toBeLessThan(script.indexOf("bun switcher.ts"));
  });
});
