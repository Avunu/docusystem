// The three scheduled workflows (section 9 of the architecture decision record): the weekly catalog
// refresh, the weekly run against the latest Jx, and the weekly fleet. Each is "informational": none
// can block a merge, none publishes, and each holds the narrowest token that does its job.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { problemsWith } from "../../scripts/check-pr-title.mjs";
import { tempDir } from "../support/index.js";
import { hasBash, hasJq, runOf, type Step, workflow } from "./helpers.js";

const catalog = workflow("catalog.yml");
const jxLatest = workflow("jx-latest.yml");
const fleet = workflow("fleet.yml");

const stepNamed = (steps: Step[] | undefined, name: string): Step => {
  const step = steps?.find((candidate) => candidate.name === name);
  if (step === undefined) throw new Error(`no step "${name}"`);
  return step;
};

describe("catalog.yml", () => {
  const job = catalog.doc.jobs.refresh;

  test("runs weekly and by hand, and holds exactly the three permissions it uses", () => {
    expect(Object.keys(catalog.doc.on).sort()).toEqual(["schedule", "workflow_dispatch"]);
    expect(job?.permissions).toEqual({
      contents: "write",
      "pull-requests": "write",
      actions: "write",
    });
  });

  test("runs `npm run sync-catalog` on the default branch, in a step that holds no token", () => {
    const checkout = job?.steps?.find((step) => step.uses?.startsWith("actions/checkout@"));
    expect(checkout?.with).toEqual({
      ref: "${{ github.event.repository.default_branch }}",
      "persist-credentials": false,
    });
    const sync = stepNamed(job?.steps, "Fetch the live catalog");
    expect(sync.run).toContain("npm run sync-catalog");
    expect(sync.env).toBeUndefined();
    expect(job?.env).toBeUndefined(); // the token is given to the steps that use it, not to the job
  });

  test("opens at most one catalog pull request at a time", () => {
    const look = stepNamed(job?.steps, "Look for an open catalog pull request");
    expect(look.run).toContain('startswith("fix/catalog-")');
    expect(stepNamed(job?.steps, "Fetch the live catalog").if).toBe(
      "${{ steps.open.outputs.count == '0' }}",
    );
  });

  test("pushes fix/catalog-<date> with the commit and title the release notes expect, then dispatches ci.yml", () => {
    const push = stepNamed(job?.steps, "Push a branch and open the pull request");
    expect(push.if).toBe("${{ steps.sync.outputs.changed == 'true' }}");
    expect(push.run).toContain('branch="fix/catalog-$(date -u +%F)"');
    expect(push.run).toContain('title="fix(catalog): refresh the bundled project catalog"');
    expect(push.run).toContain(
      'gh pr create --base "$DEFAULT_BRANCH" --head "$branch" --title "$title"',
    );
    expect(push.run).toContain('gh workflow run ci.yml --ref "$branch"');
    // Only the bundled catalog is committed.
    expect(push.run).toContain("git add site/data");
    expect(push.env).toEqual({
      GH_TOKEN: "${{ secrets.GITHUB_TOKEN }}",
      GH_REPO: "${{ github.repository }}",
      DEFAULT_BRANCH: "${{ github.event.repository.default_branch }}",
    });
  });

  test("authenticates the one push through the environment, never a command line or the checkout", () => {
    const push = stepNamed(job?.steps, "Push a branch and open the pull request").run ?? "";
    expect(push).toContain("GIT_CONFIG_COUNT=1");
    expect(push).toContain('GIT_CONFIG_KEY_0="http.https://github.com/.extraheader"');
    expect(push).toContain("::add-mask::");
    expect(push).not.toMatch(/git push [^\n]*(?:x-access-token|GH_TOKEN)/);
  });

  test("the commit title is itself a title the pull request check and release-please accept", () => {
    const title = /title="([^"]+)"/.exec(
      stepNamed(job?.steps, "Push a branch and open the pull request").run ?? "",
    )?.[1];
    expect(problemsWith(title ?? "", "")).toEqual([]);
    expect(title?.startsWith("fix(")).toBe(true); // a visible type: the refreshed catalog is a patch release
  });
});

describe.skipIf(!hasBash || !hasJq)(
  "catalog.yml, its shell steps run for real against fake `gh`, `git` and `npm`",
  () => {
    const job = catalog.doc.jobs.refresh;

    /** A folder of fake commands that log what they were called with; `gh pr list` evaluates --jq over FAKE_GH_PRS. */
    function sandbox(): {
      cwd: string;
      env: Record<string, string>;
      log: () => string;
      output: () => string;
    } {
      const root = tempDir();
      const bin = `${root}/bin`;
      mkdirSync(bin);
      const shim = (name: string, body: string) => {
        writeFileSync(`${bin}/${name}`, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
      };
      shim(
        "gh",
        `if [ "$1 $2" = "pr list" ]; then
  while [ $# -gt 0 ]; do if [ "$1" = "--jq" ]; then shift; expr="$1"; fi; shift; done
  printf '%s' "$FAKE_GH_PRS" | jq -r "$expr"
else
  printf 'gh %s\\n' "$*" >> "$FAKE_LOG"
fi`,
      );
      shim(
        "git",
        `printf 'git %s\\n' "$*" >> "$FAKE_LOG"
if [ "$1" = "push" ]; then printf 'push-auth %s\\n' "$GIT_CONFIG_VALUE_0" >> "$FAKE_LOG"; fi
if [ "$1 $2" = "diff --quiet" ]; then exit "$FAKE_DIFF_EXIT"; fi`,
      );
      shim("npm", `printf 'npm %s\\n' "$*" >> "$FAKE_LOG"`);
      writeFileSync(`${root}/log`, "");
      writeFileSync(`${root}/output`, "");
      const system = process.env.PATH ?? "";
      return {
        cwd: root,
        env: {
          PATH: `${bin}:${system}`,
          FAKE_LOG: `${root}/log`,
          GITHUB_OUTPUT: `${root}/output`,
          FAKE_DIFF_EXIT: "0",
          FAKE_GH_PRS: "[]",
        },
        log: () => readFileSync(`${root}/log`, "utf8"),
        output: () => readFileSync(`${root}/output`, "utf8"),
      };
    }

    const run = (name: string, box: ReturnType<typeof sandbox>, env: Record<string, string> = {}) =>
      spawnSync(
        "bash",
        [
          "--noprofile",
          "--norc",
          "-e",
          "-o",
          "pipefail",
          "-c",
          stepNamed(job?.steps, name).run ?? "",
        ],
        {
          cwd: box.cwd,
          env: { ...box.env, ...env },
          encoding: "utf8",
        },
      );

    test.each([
      ["no pull request is open", "[]", "0"],
      ["an unrelated pull request is open", '[{"headRefName":"feat/other"}]', "0"],
      [
        "a catalog pull request is open",
        '[{"headRefName":"fix/catalog-2026-10-05"},{"headRefName":"feat/x"}]',
        "1",
      ],
      [
        "two catalog pull requests are open",
        '[{"headRefName":"fix/catalog-a"},{"headRefName":"fix/catalog-b"}]',
        "2",
      ],
    ])("counts open catalog pull requests: %s", (_what, prs, count) => {
      const box = sandbox();
      const result = run("Look for an open catalog pull request", box, { FAKE_GH_PRS: prs });
      expect(result.status).toBe(0);
      expect(box.output().trim()).toBe(`count=${count}`);
      expect(`${result.stdout}${result.stderr}`.includes("::notice")).toBe(count !== "0");
    });

    test("reports the catalog as changed when git sees a difference in site/data, and as current when it does not", () => {
      const changed = sandbox();
      expect(run("Fetch the live catalog", changed, { FAKE_DIFF_EXIT: "1" }).status).toBe(0);
      expect(changed.output().trim()).toBe("changed=true");
      expect(changed.log()).toContain("npm run sync-catalog");

      const current = sandbox();
      expect(run("Fetch the live catalog", current, { FAKE_DIFF_EXIT: "0" }).status).toBe(0);
      expect(current.output().trim()).toBe("changed=false");
    });

    test("commits site/data on a dated branch, pushes it with the token only in the environment, opens the pull request and dispatches ci.yml", () => {
      const box = sandbox();
      const token = "ghs_FAKE_TOKEN_FOR_THE_TEST";
      const result = run("Push a branch and open the pull request", box, {
        GH_TOKEN: token,
        GH_REPO: "Avunu/docusystem",
        DEFAULT_BRANCH: "main",
      });
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      const log = box.log();
      const branch = /^git switch --create (fix\/catalog-\d{4}-\d{2}-\d{2})$/m.exec(log)?.[1];
      expect(branch).toBeDefined();
      expect(log).toContain("git add site/data");
      expect(log).toContain(
        "git commit --quiet --message fix(catalog): refresh the bundled project catalog --message",
      );
      expect(log).toContain(`git push origin HEAD:refs/heads/${branch}`);
      expect(log).toContain(`gh workflow run ci.yml --ref ${branch}`);
      expect(log).toMatch(
        new RegExp(
          `gh pr create --base main --head ${branch} --title fix\\(catalog\\): refresh the bundled project catalog --body-file \\S+`,
        ),
      );
      // The token is never an argument of any command; git receives it, base64-encoded, in the environment.
      expect(log.replace(/^push-auth .*$/m, "")).not.toContain(token);
      const auth = /^push-auth AUTHORIZATION: basic (\S+)$/m.exec(log)?.[1];
      expect(Buffer.from(auth ?? "", "base64").toString()).toBe(`x-access-token:${token}`);
      // The sequence: commit, push, pull request, dispatch.
      const at = (needle: string) => log.indexOf(needle);
      expect(at("git commit")).toBeLessThan(at("git push"));
      expect(at("git push")).toBeLessThan(at("gh pr create"));
      expect(at("gh pr create")).toBeLessThan(at("gh workflow run"));
    });
  },
);

describe("jx-latest.yml", () => {
  const canary = jxLatest.doc.jobs.canary;
  const report = jxLatest.doc.jobs.report;

  test("runs weekly and by hand; the job that runs code has a read-only token, the reporter alone can write issues", () => {
    expect(Object.keys(jxLatest.doc.on).sort()).toEqual(["schedule", "workflow_dispatch"]);
    expect(canary?.permissions).toEqual({ contents: "read" });
    expect(report?.permissions).toEqual({ issues: "write" });
    expect(report?.steps?.some((step) => step.uses?.startsWith("actions/checkout@"))).toBe(false);
  });

  test("installs the latest of exactly the four Jx packages over the pins, without saving and without scripts", () => {
    const install = stepNamed(canary?.steps, "Install the latest Jx over the pins").run ?? "";
    expect(install).toContain("npm install --no-save --ignore-scripts");
    for (const name of ["compiler", "parser", "runtime", "search"]) {
      expect(install).toContain(`@jxsuite/${name}@latest`);
    }
    expect(install).not.toMatch(/@jxsuite\/server/);
  });

  test("then runs the real-Jx canary and builds the example with the installed Jx, in strict CI mode", () => {
    const order = (canary?.steps ?? []).map((step) => step.name);
    expect(order.indexOf("Install the latest Jx over the pins")).toBeLessThan(
      order.indexOf("The real-Jx canary"),
    );
    expect(stepNamed(canary?.steps, "The real-Jx canary").run).toBe(
      "npm test -- --project integration",
    );
    const example = stepNamed(canary?.steps, "Check the example with the latest Jx");
    expect(example.run).toBe("node dist/cli.js check --ci --site examples/basic/docs-site");
    expect(example.env).toEqual({ CI: "true" });
  });

  test("reports after the canary, whatever its result except skipped, and the shell of the version listing works", () => {
    expect(report?.needs).toBe("canary");
    expect(report?.if).toBe("${{ always() && needs.canary.result != 'skipped' }}");
    expect(canary?.outputs).toEqual({ versions: "${{ steps.install.outputs.versions }}" });
  });

  test.skipIf(!hasBash)("lists the four installed versions from their package.json files", () => {
    const script = runOf(jxLatest, "canary", "Install the latest Jx over the pins");
    // Run only the listing part, against a fake node_modules.
    const listing = /(versions="\$\(jq[\s\S]*?\)")\n/.exec(script)?.[1];
    expect(listing).toBeDefined();
    const root = tempDir();
    for (const [name, version] of [
      ["compiler", "9.0.0"],
      ["parser", "8.0.0"],
      ["runtime", "7.0.0"],
      ["search", "6.0.0"],
    ]) {
      mkdirSync(`${root}/node_modules/@jxsuite/${name}`, { recursive: true });
      writeFileSync(
        `${root}/node_modules/@jxsuite/${name}/package.json`,
        JSON.stringify({ name: `@jxsuite/${name}`, version }),
      );
    }
    const result = spawnSync(
      "bash",
      ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", `${listing}\necho "$versions"`],
      {
        cwd: root,
        env: { PATH: process.env.PATH ?? "" },
        encoding: "utf8",
      },
    );
    expect(result.stdout.trim()).toBe(
      "@jxsuite/compiler 9.0.0, @jxsuite/parser 8.0.0, @jxsuite/runtime 7.0.0, @jxsuite/search 6.0.0",
    );
  });

  test("opens one issue, or comments on the open one, and says so when the run is green again", () => {
    const script = stepNamed(report?.steps, "Report").run ?? "";
    expect(script).toContain("gh issue list --state open --label jx-latest --limit 1");
    expect(script).toContain('gh issue comment "$existing"');
    expect(script).toContain("gh label create jx-latest");
    expect(script).toContain(
      'gh issue create --label jx-latest --title "The latest Jx breaks the docs system"',
    );
    expect(script.indexOf("gh label create")).toBeLessThan(script.indexOf("gh issue create"));
    expect(script).toContain("is green again");
  });
});

describe("fleet.yml", () => {
  const job = fleet.doc.jobs.fleet;

  test("runs weekly and by hand, read-only, and accepts one repository to adopt", () => {
    expect(Object.keys(fleet.doc.on).sort()).toEqual(["schedule", "workflow_dispatch"]);
    expect(job?.permissions).toEqual({ contents: "read" });
    const dispatch = fleet.doc.on.workflow_dispatch as { inputs: Record<string, { type: string }> };
    expect(Object.keys(dispatch.inputs)).toEqual(["repo"]);
    expect(dispatch.inputs.repo?.type).toBe("string");
  });

  test("builds, then runs scripts/fleet.mjs, the repository input reaching it only through the environment", () => {
    const step = stepNamed(job?.steps, "Adopt the build in the fleet");
    expect(step.env).toEqual({ FLEET_REPO: "${{ inputs.repo }}" });
    expect(step.run).toContain("node scripts/fleet.mjs\n");
    expect(step.run).toContain('node scripts/fleet.mjs --repo "$FLEET_REPO"');
    const names = (job?.steps ?? []).map((candidate) => candidate.name);
    expect(names.indexOf("Build")).toBeLessThan(names.indexOf("Adopt the build in the fleet"));
  });

  describe.skipIf(!hasBash)(
    "the shell of the repository input, run for real with a fake fleet.mjs",
    () => {
      const script = runOf(fleet, "fleet", "Adopt the build in the fleet");
      const run = (repo: string) => {
        const root = tempDir();
        mkdirSync(`${root}/scripts`);
        writeFileSync(
          `${root}/scripts/fleet.mjs`,
          "console.log(`fleet:${process.argv.slice(2).join(' ')}`);\n",
        );
        const result = spawnSync(
          "bash",
          ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", script],
          {
            cwd: root,
            env: { PATH: process.env.PATH ?? "", FLEET_REPO: repo },
            encoding: "utf8",
          },
        );
        return { code: result.status, out: `${result.stdout}${result.stderr}` };
      };

      test("no input adopts the whole fleet", () => {
        const result = run("");
        expect(result.code).toBe(0);
        expect(result.out.trim()).toBe("fleet:");
      });

      test("a repository of the form owner/name is passed as one argument", () => {
        const result = run("Avunu/frappe-nix");
        expect(result.code).toBe(0);
        expect(result.out.trim()).toBe("fleet:--repo Avunu/frappe-nix");
      });

      test.each(["frappe-nix", "Avunu/a b", "Avunu/x;id", "$(id)/x", "a/b/c", "--help"])(
        "refuses %s",
        (value) => {
          const result = run(value);
          expect(result.code).toBe(1);
          expect(result.out).toContain("::error title=repo::");
        },
      );
    },
  );
});
