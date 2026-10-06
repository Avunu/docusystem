// The release pipeline (section 8.2 of the architecture decision record): release.yml, the
// release-please configuration it reads, and the pull request title rule that keeps release-please
// from silently skipping a commit.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { Ajv } from "ajv";
import { describe, expect, test } from "vitest";
import { TYPES } from "../../scripts/check-pr-title.mjs";
import { tempDir } from "../support/index.js";
import { hasBash, readJson, readText, runOf, workflow, type Job, type Step } from "./helpers.js";

const release = workflow("release.yml");
const jobs = release.doc.jobs;
const build = jobs.build;
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

  test("has three jobs, the release pull request, the build and the publish, and no job that moves a tag", () => {
    expect(Object.keys(jobs)).toEqual(["release-please", "build", "publish"]);
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

  test("publish needs the release and the build, runs only when a release was created, in the npm environment, with OIDC and nothing else", () => {
    expect(publish?.needs).toEqual(["release-please", "build"]);
    expect(publish?.if).toBe("${{ needs.release-please.outputs.release-created == 'true' }}");
    expect(publish?.environment).toBe("npm");
    expect(publish?.permissions).toEqual({ "id-token": "write" });
  });

  test("build needs the release, runs only when a release was created, and reads the repository and nothing else", () => {
    expect(build?.needs).toBe("release-please");
    expect(build?.if).toBe("${{ needs.release-please.outputs.release-created == 'true' }}");
    expect(build?.permissions).toEqual({ contents: "read" });
  });

  test("build checks out the release commit and installs, checks, builds and checks the pack before packing", () => {
    const steps = build?.steps ?? [];
    expect(stepWith(steps, "actions/checkout@")?.with).toEqual({
      ref: "${{ needs.release-please.outputs.sha }}",
      "persist-credentials": false,
    });
    // No registry-url: nothing in this job publishes, so no .npmrc that names a token is written.
    expect(stepWith(steps, "actions/setup-node@")?.with).toEqual({
      "node-version": "24",
      "package-manager-cache": false,
    });
    const install = steps.find(
      (step) => step.name === "Install, check and build at the release commit",
    );
    expect(install?.run?.trimEnd().split("\n")).toEqual([
      "npm ci --ignore-scripts --no-audit --no-fund",
      "npm run check",
      "npm run build",
      "npm run check:pack",
    ]);
    const order = steps.map((step) => step.name);
    expect(order.indexOf("Install, check and build at the release commit")).toBeLessThan(
      order.indexOf("Pack the tarball"),
    );
  });

  test("build packs what check:pack inspected, without running scripts, and hands the tarball to publish", () => {
    const steps = build?.steps ?? [];
    const pack = steps.find((step) => step.name === "Pack the tarball");
    // The same flags as scripts/check-pack.mjs: the tarball is the build that was checked, not a new one.
    expect(pack?.run).toContain('npm pack --ignore-scripts --pack-destination "$DESTINATION"');
    // npm refuses a destination that does not exist.
    expect((pack?.run ?? "").indexOf('mkdir -p "$DESTINATION"')).toBeGreaterThan(-1);
    expect(pack?.env?.DESTINATION).toBe("${{ runner.temp }}/tarball");
    const upload = stepWith(steps, "actions/upload-artifact@");
    expect(upload?.with).toMatchObject({
      name: "package-tarball",
      path: "${{ runner.temp }}/tarball/*.tgz",
      "if-no-files-found": "error",
    });
    expect(steps.at(-1)).toBe(upload);
  });

  test("the tarball crosses to publish as an artifact of the same run, and publish downloads that one", () => {
    const upload = stepWith(build?.steps, "actions/upload-artifact@");
    const download = stepWith(publish?.steps, "actions/download-artifact@");
    expect(download?.with?.name).toBe(upload?.with?.name);
    expect(download?.with?.path).toBe("${{ runner.temp }}/tarball");
    // A download from another run or repository would need a token and a run id.
    expect(Object.keys(download?.with ?? {}).sort()).toEqual(["name", "path"]);
  });

  describe("the job that holds the OIDC token runs none of the repository's code", () => {
    // Every step of a job with `id-token: write` sees ACTIONS_ID_TOKEN_REQUEST_URL and _TOKEN, and npm
    // exchanges that token for a publish credential without asking what ran before. Code of the
    // development dependencies (the test runner, the linter, the compiler) must therefore never run in
    // that job; it runs in `build`, which has no id-token, no environment and no secret.
    const runLines = (job: Job | undefined): string[] =>
      (job?.steps ?? []).flatMap((step) =>
        (step.run ?? "").split("\n").flatMap((line) => (line.trim() === "" ? [] : [line.trim()])),
      );

    test("only publish holds id-token: write, and only build installs the toolchain", () => {
      const holders = Object.entries(jobs)
        .filter(([, job]) => job.permissions?.["id-token"] === "write")
        .map(([id]) => id);
      expect(holders).toEqual(["publish"]);
      const installers = Object.entries(jobs)
        .filter(([, job]) => runLines(job).some((line) => /^npm (?:ci|install|i)\b/.test(line)))
        .map(([id]) => id);
      expect(installers).toEqual(["build"]);
    });

    test("build has no id-token, no environment and no secret, so no step of it can obtain a publish credential", () => {
      expect(build?.permissions).not.toHaveProperty("id-token");
      expect(build?.environment).toBeUndefined();
      const text = JSON.stringify(build);
      expect(text).not.toMatch(/secrets\./);
      expect(text).not.toMatch(/NODE_AUTH_TOKEN|NPM_TOKEN|id-token/);
      expect(runLines(build).join("\n")).not.toMatch(/\bnpm publish\b/);
    });

    test("publish checks nothing out and installs nothing: it downloads the tarball, sets up Node and publishes it", () => {
      const steps = publish?.steps ?? [];
      expect(steps.map((step) => step.uses?.split("@")[0] ?? "run")).toEqual([
        "actions/download-artifact",
        "actions/setup-node",
        "run",
      ]);
      expect(stepWith(steps, "actions/checkout@")).toBeUndefined();
      expect(stepWith(steps, "actions/setup-node@")?.with).toEqual({
        "node-version": "24",
        "registry-url": "https://registry.npmjs.org",
        "package-manager-cache": false,
      });
      // The only commands: read the tarball, ask the registry, publish. Not one of them runs a script
      // of the repository or of a dependency.
      for (const line of runLines(publish)) {
        expect(line).not.toMatch(/^(?:npm (?:ci|install|i|run|exec|test)\b|npx\b|bunx?\b)/);
      }
    });

    test("publish publishes the tarball, never the directory: no prepack or prepublishOnly runs with the token in the environment", () => {
      const lines = runLines(publish);
      // `npm publish` with no argument, or `.`, would pack the (absent) directory and run its scripts.
      // Only commands count here, not the words of an error annotation that name the command.
      const commands = lines.filter((line) => /^(?:if ! )?npm publish\b/.test(line));
      expect(commands).toEqual([
        'if ! npm publish "$tarball" --provenance --access public --loglevel verbose; then',
      ]);
    });
  });

  test("the publish step signs with provenance, is safe to re-run, and keeps NPM_TOKEN wired for route A only", () => {
    const step = publish?.steps?.find(
      (candidate) => candidate.name === "Publish (skipped when the version already exists)",
    );
    expect(step?.env).toEqual({
      PACKAGE: "@avunu/docusystem",
      TARBALL_DIR: "${{ runner.temp }}/tarball",
      VERSION: "${{ needs.release-please.outputs.version }}",
      NODE_AUTH_TOKEN: "${{ secrets.NPM_TOKEN }}",
    });
    const script = step?.run ?? "";
    expect(script).toContain("npm publish");
    expect(script).toContain('npm view "$name@$VERSION" version');
    expect(script).toContain("is already on npm; nothing to publish");
    // A tarball that disagrees with release-please is refused before anything is published.
    expect(script.indexOf('"$have" != "$VERSION"')).toBeGreaterThan(-1);
    expect(script.indexOf('"$have" != "$VERSION"')).toBeLessThan(script.indexOf("npm publish"));
    expect(readJson<{ name: string }>("package.json").name).toBe(step?.env?.PACKAGE);
  });

  test("the publish job's inputs are the outputs of release-please's own step, so only the run that created the release can publish it", () => {
    // release-please reports a release only for a merged pull request still labelled
    // `autorelease: pending`, and relabels it `autorelease: tagged` when it tags. A later run (Re-run
    // all jobs, a dispatch, any push) therefore reports none and skips publish: MAINTAINING.md says so.
    expect(please?.outputs).toEqual({
      "release-created": "${{ steps.rp.outputs.release_created }}",
      "tag-name": "${{ steps.rp.outputs.tag_name }}",
      version: "${{ steps.rp.outputs.version }}",
      sha: "${{ steps.rp.outputs.sha }}",
    });
  });

  test("publishing sits in the same file as release-please: npm trusted publishing names the workflow file", () => {
    const text = release.text;
    expect(text).toContain("googleapis/release-please-action@");
    expect(text).toContain("npm publish");
  });
});

describe.skipIf(!hasBash || spawnSync("tar", ["--version"]).status !== 0)(
  "the publish step, run for real against a stub npm",
  () => {
    const script = runOf(release, "publish", "Publish (skipped when the version already exists)");

    /** A scratch tree: the folder the tarball was downloaded to, a stub `npm` that logs, and its log. */
    function scene(tarballs: { name: string; version: string; file?: string }[]) {
      const root = tempDir();
      const tarballDir = join(root, "tarball");
      const bin = join(root, "bin");
      const log = join(root, "npm.log");
      mkdirSync(tarballDir, { recursive: true });
      mkdirSync(bin, { recursive: true });
      for (const { name, version, file } of tarballs) {
        const source = join(root, `source-${file ?? version}`);
        mkdirSync(join(source, "package"), { recursive: true });
        writeFileSync(join(source, "package", "package.json"), JSON.stringify({ name, version }));
        const made = spawnSync("tar", [
          "-czf",
          join(tarballDir, file ?? `avunu-docusystem-${version}.tgz`),
          "-C",
          source,
          "package",
        ]);
        expect(made.status).toBe(0);
      }
      // `npm view` exits 0 when the version is on the registry and 1 when it is not.
      // `npm publish` exits PUBLISH_EXIT; a refusal prints what npm prints at its default log level.
      writeFileSync(
        join(bin, "npm"),
        [
          "#!/bin/sh",
          'echo "$*" >> "$NPM_LOG"',
          'case "$1" in',
          '  view) exit "$VIEW_EXIT" ;;',
          "  publish)",
          '    if [ "$PUBLISH_EXIT" -ne 0 ]; then',
          '      echo "npm error code ENEEDAUTH" >&2',
          '      echo "npm error need auth This command requires you to be logged in to https://registry.npmjs.org/" >&2',
          "    fi",
          '    exit "$PUBLISH_EXIT" ;;',
          "esac",
          "exit 0",
          "",
        ].join("\n"),
      );
      chmodSync(join(bin, "npm"), 0o755);
      return { root, tarballDir, bin, log };
    }

    function run(
      s: ReturnType<typeof scene>,
      o: { version?: string; package?: string; onRegistry?: boolean; publishExit?: number } = {},
    ) {
      const result = spawnSync(
        "bash",
        ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", script],
        {
          cwd: s.root,
          encoding: "utf8",
          env: {
            PATH: `${s.bin}${delimiter}${process.env.PATH ?? ""}`,
            NPM_LOG: s.log,
            VIEW_EXIT: o.onRegistry === true ? "0" : "1",
            PUBLISH_EXIT: String(o.publishExit ?? 0),
            PACKAGE: o.package ?? "@avunu/docusystem",
            TARBALL_DIR: s.tarballDir,
            VERSION: o.version ?? "0.1.0",
          },
        },
      );
      let calls: string[] = [];
      try {
        calls = readFileSync(s.log, "utf8").trim().split("\n");
      } catch {
        // the stub was never called
      }
      return { code: result.status, out: `${result.stdout}${result.stderr}`, calls };
    }

    test("publishes the downloaded tarball with provenance and public access, at the verbose level (npm view stays quiet)", () => {
      const s = scene([{ name: "@avunu/docusystem", version: "0.1.0" }]);
      const result = run(s);
      expect(result.out).toBe("");
      expect(result.code).toBe(0);
      // Verbose is where npm prints the registry's reason for a refused OIDC exchange (`npm verbose oidc`).
      expect(result.calls).toEqual([
        "view @avunu/docusystem@0.1.0 version",
        `publish ${join(s.tarballDir, "avunu-docusystem-0.1.0.tgz")} --provenance --access public --loglevel verbose`,
      ]);
    });

    test("a failed publish fails the step and says where to look: the verbose oidc line, the record, the runbook", () => {
      const result = run(scene([{ name: "@avunu/docusystem", version: "0.1.0" }]), {
        publishExit: 1,
      });
      expect(result.code).toBe(1);
      // npm's own output is left alone.
      expect(result.out).toContain("ENEEDAUTH");
      const annotations = result.out.split("\n").filter((line) => line.startsWith("::error"));
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
    });

    test("publishes nothing when the version is already on npm, so re-running a failed run is safe", () => {
      const s = scene([{ name: "@avunu/docusystem", version: "0.1.0" }]);
      const result = run(s, { onRegistry: true });
      expect(result.code).toBe(0);
      expect(result.out).toContain("@avunu/docusystem@0.1.0 is already on npm; nothing to publish");
      expect(result.out).not.toContain("::error");
      expect(result.calls).toEqual(["view @avunu/docusystem@0.1.0 version"]);
    });

    test("refuses a tarball whose version is not the one release-please released, before asking npm anything", () => {
      const s = scene([{ name: "@avunu/docusystem", version: "0.1.1" }]);
      const result = run(s, { version: "0.1.0" });
      expect(result.code).toBe(1);
      expect(result.out).toContain("::error::");
      expect(result.out).toContain("0.1.1");
      expect(result.out).toContain("release-please released 0.1.0");
      expect(result.calls).toEqual([]);
    });

    test("refuses a tarball of another package", () => {
      const s = scene([{ name: "left-pad", version: "0.1.0" }]);
      const result = run(s);
      expect(result.code).toBe(1);
      expect(result.out).toContain("::error::");
      expect(result.out).toContain("left-pad");
      expect(result.calls).toEqual([]);
    });

    test("refuses a download with no tarball, and one with two", () => {
      const none = run(scene([]));
      expect(none.code).toBe(1);
      expect(none.out).toContain("::error::");
      expect(none.calls).toEqual([]);

      const two = run(
        scene([
          { name: "@avunu/docusystem", version: "0.1.0" },
          { name: "@avunu/docusystem", version: "0.1.0", file: "second.tgz" },
        ]),
      );
      expect(two.code).toBe(1);
      expect(two.out).toContain("::error::");
      expect(two.calls).toEqual([]);
    });
  },
);

// The trusted publisher on npmjs.com cannot be read from a pull request (`npm trust list` needs
// interactive two-factor authentication), and when its record does not match the run, npm 11 reports
// only ENEEDAUTH at its default log level. The publish step above explains a refusal; this keeps the
// record that the runbook asks for equal to the one this workflow presents to npm.
describe("the trusted publisher record the runbook asks for", () => {
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
    const script = runOf(release, "publish", "Publish (skipped when the version already exists)");
    expect(script).toContain("npm publish ");
    expect(script).not.toContain("npm stage");
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

describe("MAINTAINING.md, how a failed publish is retried", () => {
  const maintaining = readText("MAINTAINING.md");

  test("names Re-run failed jobs as the retry, and warns off Re-run all jobs, a dispatch and a push", () => {
    expect(maintaining).toContain("**Re-run failed jobs**");
    expect(maintaining).toMatch(
      /Never choose \*\*Re-run all jobs\*\*, start the workflow by hand or push/,
    );
    // The reason: the release pull request is relabelled when it is tagged, so a second run sees no release.
    expect(maintaining).toContain("`autorelease: pending`");
    expect(maintaining).toContain("`autorelease: tagged`");
    expect(maintaining).toContain("the run is green with nothing published");
  });

  test("says a failure in the code at the release commit needs a fix: commit and a new release, then how to verify", () => {
    expect(maintaining).toContain("the tag `v<VERSION>` stays on that commit");
    expect(maintaining).toContain("`fix:` commit and the next release");
    expect(maintaining).toContain("npm view @avunu/docusystem@<VERSION> _npmUser");
  });

  test("no longer promises that any re-run of a failed run is safe", () => {
    expect(maintaining).not.toMatch(/re-running a failed run is safe/i);
  });
});
