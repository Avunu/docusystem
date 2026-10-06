// The two reusable workflows every documentation site calls (section 4.4 of the architecture decision
// record). Their inputs, permissions, job names and the contract with the CLI are semver surface: a
// change here is a major (from 1.0), so the facts a caller relies on are pinned down one by one.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { WORKFLOW_CONTRACT } from "../../src/lib/package-info.js";
import { tempDir } from "../support/index.js";
import { hasBash, hasJq, runOf, type Step, workflow } from "./helpers.js";

const build = workflow("docs-build.yml");
const deploy = workflow("docs-deploy.yml");
const check = build.doc.jobs.check;
const publish = deploy.doc.jobs.deploy;

/** GitHub runs `run:` steps with `bash --noprofile --norc -e -o pipefail`. */
function bash(script: string, cwd: string, env: Record<string, string>) {
  const result = spawnSync(
    "bash",
    ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", script],
    {
      cwd,
      env: { PATH: process.env.PATH ?? "", ...env },
      encoding: "utf8",
    },
  );
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

const stepNamed = (name: string): Step => {
  const step = check?.steps?.find((candidate) => candidate.name === name);
  if (step === undefined) throw new Error(`docs-build.yml has no step "${name}"`);
  return step;
};

describe("docs-build.yml", () => {
  test("is called with workflow_call alone, takes two inputs and returns and needs nothing else", () => {
    expect(Object.keys(build.doc.on)).toEqual(["workflow_call"]);
    const call = build.doc.on.workflow_call as { inputs: Record<string, Record<string, unknown>> };
    expect(Object.keys(call)).toEqual(["inputs"]); // no secrets, no outputs
    expect(Object.keys(call.inputs).sort()).toEqual(["pages-artifact", "site-directory"]);
    expect(call.inputs["site-directory"]).toMatchObject({
      required: false,
      type: "string",
      default: "docs-site",
    });
    expect(call.inputs["pages-artifact"]).toMatchObject({
      required: false,
      type: "boolean",
      default: false,
    });
  });

  test("has one job, check, named Check (a caller's required check is `build / Check`), read-only", () => {
    expect(Object.keys(build.doc.jobs)).toEqual(["check"]);
    expect(check?.name).toBe("Check");
    expect(check?.permissions).toEqual({ contents: "read" });
    expect(build.doc.permissions).toEqual({});
  });

  test("builds on a push only for the default branch", () => {
    expect(check?.if).toBe(
      "${{ github.event_name != 'push' || github.ref == format('refs/heads/{0}', github.event.repository.default_branch) }}",
    );
  });

  test("sets the workflow contract the CLI checks, and the CLI's own constant is the same number", () => {
    const literal = build.doc.env?.DOCUSYSTEM_WORKFLOW_CONTRACT;
    expect(literal).toBe(String(WORKFLOW_CONTRACT));
    expect(Number.isInteger(Number(literal))).toBe(true);
    expect(check?.env?.DOCUSYSTEM_BRANCH).toBe("${{ github.event.repository.default_branch }}");
    expect(check?.env?.SITE_DIR).toBe("${{ inputs.site-directory }}");
  });

  test("runs the steps of section 4.4 in order", () => {
    const steps = check?.steps ?? [];
    const names = steps.map((step) => step.name);
    expect(names).toEqual([
      "Check the site directory",
      "Check out the repository",
      "Check the lockfile",
      "Set up Node.js",
      "Install the locked dependencies",
      "Verify package signatures and the docs system's provenance",
      "Check and build the site",
      "Upload the site for review",
      "Package the site for GitHub Pages",
      "Upload the assembled project for debugging",
    ]);
  });

  test("installs the lockfile frozen, without scripts, on Node 24, and runs the INSTALLED CLI in strict CI mode", () => {
    expect(stepNamed("Set up Node.js").with).toMatchObject({
      "node-version": "24",
      "package-manager-cache": false,
    });
    expect(stepNamed("Check out the repository").with).toMatchObject({
      "persist-credentials": false,
    });
    expect(stepNamed("Install the locked dependencies")).toMatchObject({
      run: "npm ci --ignore-scripts --no-audit --no-fund",
      "working-directory": "${{ inputs.site-directory }}",
    });
    const cli = stepNamed("Check and build the site");
    expect(cli.run).toBe("./node_modules/.bin/docusystem check --ci");
    expect(cli.env).toEqual({ CI: "true" });
    expect(cli["working-directory"]).toBe("${{ inputs.site-directory }}");
  });

  test("verifies signatures and requires a verified provenance attestation for @avunu/docusystem", () => {
    const script = runOf(
      build,
      "check",
      "Verify package signatures and the docs system's provenance",
    );
    expect(script).toContain("npm audit signatures\n");
    expect(script).toContain("npm audit signatures --json --include-attestations");
    expect(script).toContain(
      'select(.name == "@avunu/docusystem" and .attestations.provenance != null)',
    );
    expect(script).toContain("(.invalid | length) == 0");
  });

  test("uploads the review artifact on a pull request or without pages-artifact, the Pages artifact otherwise", () => {
    const review = stepNamed("Upload the site for review");
    expect(review.if).toBe("${{ github.event_name == 'pull_request' || !inputs.pages-artifact }}");
    expect(review.with).toMatchObject({
      name: "docs-site",
      path: "${{ inputs.site-directory }}/dist",
      "retention-days": 7,
      "if-no-files-found": "error",
      "include-hidden-files": true,
    });
    const pages = stepNamed("Package the site for GitHub Pages");
    expect(pages.if).toBe("${{ github.event_name != 'pull_request' && inputs.pages-artifact }}");
    expect(pages.uses).toMatch(/^actions\/upload-pages-artifact@/);
    expect(pages.with).toMatchObject({
      path: "${{ inputs.site-directory }}/dist",
      "include-hidden-files": true,
    });
  });

  test("on failure uploads what a maintainer needs without a checkout: manifest, jx.log, the assembled root", () => {
    const debug = stepNamed("Upload the assembled project for debugging");
    expect(debug.if).toBe("${{ failure() }}");
    expect(debug.with?.name).toBe("docusystem-debug");
    const path = String(debug.with?.path);
    for (const needle of [
      ".docusystem/manifest.json",
      ".docusystem/jx.log",
      ".docusystem/site",
      "!${{ inputs.site-directory }}/.docusystem/site/node_modules",
    ]) {
      expect(path).toContain(needle);
    }
    expect(debug.with?.["include-hidden-files"]).toBe(true);
  });

  test("the site directory reaches shells only through the environment", () => {
    for (const step of check?.steps ?? []) expect(step.run ?? "").not.toContain("${{");
    expect(stepNamed("Check the site directory").env).toBeUndefined(); // it reads the job's SITE_DIR
  });

  describe.skipIf(!hasBash)("the shell of the site-directory check, run for real", () => {
    const script = runOf(build, "check", "Check the site directory");
    const dir = () => tempDir();

    test.each(["docs-site", "site", "docs/site", "_private", "a.b/c-d_e", "Docs2"])(
      "accepts %s",
      (value) => {
        expect(bash(script, dir(), { SITE_DIR: value }).code).toBe(0);
      },
    );

    test.each([
      ["a path that climbs out", "../docs-site"],
      ["a climb in the middle", "docs/../x"],
      ["a double dot inside a name", "a..b"],
      ["an absolute path", "/etc"],
      ["a leading dash", "-rf"],
      ["a leading dot", ".hidden"],
      ["a space", "docs site"],
      ["a command substitution", "$(touch pwned)"],
      ["a semicolon", "a;b"],
      ["a backtick", "`id`"],
      ["a newline", "a\nb"],
      ["an empty value", ""],
    ])("refuses %s", (_what, value) => {
      const result = bash(script, dir(), { SITE_DIR: value });
      expect(result.code).toBe(1);
      expect(result.out).toContain("::error title=site-directory::");
    });
  });

  describe.skipIf(!hasBash)("the shell of the lockfile check, run for real", () => {
    const script = runOf(build, "check", "Check the lockfile");
    const site = (files: string[]) => {
      const root = tempDir();
      mkdirSync(root, { recursive: true });
      for (const file of files) writeFileSync(`${root}/${file}`, "");
      return root;
    };

    test("passes with package-lock.json alone", () => {
      expect(bash(script, site(["package-lock.json"]), { SITE_DIR: "docs-site" }).code).toBe(0);
    });

    test.each(["bun.lock", "bun.lockb"])("refuses %s, with the way out", (lockfile) => {
      const result = bash(script, site(["package-lock.json", lockfile]), { SITE_DIR: "docs-site" });
      expect(result.code).toBe(1);
      expect(result.out).toContain("::error title=lockfile::");
      expect(result.out).toContain("npm install");
    });

    test("refuses a site with no package-lock.json", () => {
      const result = bash(script, site(["package.json"]), { SITE_DIR: "docs-site" });
      expect(result.code).toBe(1);
      expect(result.out).toContain("commit package-lock.json");
    });
  });

  describe.skipIf(!hasBash || !hasJq)(
    "the provenance assertion, run for real against recorded npm output",
    () => {
      // The jq program of the step, applied to what `npm audit signatures --json --include-attestations`
      // prints. The shape is npm's: { invalid: [...], missing: [...], verified: [{ name, version, attestations }] }.
      const script = runOf(
        build,
        "check",
        "Verify package signatures and the docs system's provenance",
      );
      const jq = /\| jq -e '([\s\S]*?)' > \/dev\/null/.exec(script)?.[1];

      const decide = (audit: unknown): number | null =>
        spawnSync("jq", ["-e", jq ?? ""], { input: JSON.stringify(audit), encoding: "utf8" })
          .status;

      test("extracts the jq program from the step", () => {
        expect(jq).toContain("@avunu/docusystem");
      });

      const verified = (name: string, provenance: object | null) => ({
        name,
        version: "0.1.0",
        attestations: { provenance },
      });

      test("passes when @avunu/docusystem has a verified provenance attestation and nothing is invalid", () => {
        expect(
          decide({
            invalid: [],
            missing: [],
            verified: [verified("@avunu/docusystem", { predicateType: "slsa" })],
          }),
        ).toBe(0);
      });

      test("fails without an attestation for the docs system", () => {
        expect(decide({ invalid: [], verified: [verified("@avunu/docusystem", null)] })).toBe(1);
        expect(
          decide({ invalid: [], verified: [verified("yaml", { predicateType: "slsa" })] }),
        ).toBe(1);
        expect(decide({ invalid: [], verified: [] })).toBe(1);
      });

      test("fails when any signature is invalid, even if the docs system is attested", () => {
        expect(
          decide({
            invalid: [{ name: "left-pad", version: "1.0.0" }],
            verified: [verified("@avunu/docusystem", { predicateType: "slsa" })],
          }),
        ).toBe(1);
      });
    },
  );
});

describe("docs-deploy.yml", () => {
  test("is called with workflow_call alone, has no inputs and no secrets, and returns the page URL", () => {
    expect(Object.keys(deploy.doc.on)).toEqual(["workflow_call"]);
    const call = deploy.doc.on.workflow_call as {
      outputs: Record<string, { value: string }>;
    } & Record<string, unknown>;
    expect(Object.keys(call)).toEqual(["outputs"]);
    expect(Object.keys(call.outputs)).toEqual(["page-url"]);
    expect(call.outputs["page-url"]?.value).toBe("${{ jobs.deploy.outputs.page-url }}");
    expect(deploy.doc.permissions).toEqual({});
  });

  test("has one job, deploy, named Publish, that runs only off a pull request and on the default branch", () => {
    expect(Object.keys(deploy.doc.jobs)).toEqual(["deploy"]);
    expect(publish?.name).toBe("Publish");
    expect(publish?.if).toBe(
      "${{ github.event_name != 'pull_request' && github.ref == format('refs/heads/{0}', github.event.repository.default_branch) }}",
    );
  });

  test("holds exactly pages: write and id-token: write, in the github-pages environment, never cancelled half way", () => {
    expect(publish?.permissions).toEqual({ pages: "write", "id-token": "write" });
    expect(publish?.environment).toEqual({
      name: "github-pages",
      url: "${{ steps.deployment.outputs.page_url }}",
    });
    expect(publish?.concurrency).toEqual({ group: "pages", "cancel-in-progress": false });
    expect(publish?.outputs).toEqual({ "page-url": "${{ steps.deployment.outputs.page_url }}" });
  });

  test("executes no project code: no checkout, no shell, only configure-pages and deploy-pages", () => {
    const steps = publish?.steps ?? [];
    expect(steps.map((step) => step.uses?.split("@")[0])).toEqual([
      "actions/configure-pages",
      "actions/deploy-pages",
    ]);
    for (const step of steps) expect(step.run).toBeUndefined();
    expect(deploy.text).not.toContain("actions/checkout");
  });
});
