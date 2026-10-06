// `docusystem doctor` (4.1.3): every row of the table, in the state that makes it fire and in the
// state that does not, including the two false OKs the judges found. The repository under test is
// the one init writes (so init and doctor are checked against each other), changed one thing at a
// time. WP1's config module and WP2's overrides are the fakes of ./support/neighbours.ts until merged.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { diagnose, run } from "../../src/commands/doctor.js";
import { runInit } from "../../src/commands/init.js";
import { overrideFindings } from "../../src/lib/overrides.js";
import type { Finding } from "../../src/lib/types.js";
import { runCli, testContext } from "../support/index.js";
import { readFixture } from "./support/fixtures.js";
import {
  copyPilotGithub,
  envFor,
  exec,
  makeRepo,
  PILOTS,
  readIn,
  rewrite,
  SHA,
} from "./support/shell.js";
import { initialisedRepo } from "./support/initialised.js";

vi.mock("../../src/lib/config.js", (original) =>
  import("./support/neighbours.js").then((m) => m.mockConfig(original)),
);
vi.mock("../../src/lib/catalog.js", (original) =>
  import("./support/neighbours.js").then((m) => m.mockCatalog(original)),
);
vi.mock("../../src/lib/preflight.js", (original) =>
  import("./support/neighbours.js").then((m) => m.mockPreflight(original)),
);
vi.mock("../../src/lib/overrides.js", (original) =>
  import("./support/neighbours.js").then((m) => m.mockOverrides(original)),
);
vi.mock("../../src/lib/package-info.js", (original) =>
  import("./support/neighbours.js").then((m) => m.mockPackageInfo(original)),
);

beforeEach(() => {
  vi.mocked(overrideFindings).mockClear();
});

const site = (root: string): string => join(root, "docs-site");
const all = (root: string): Finding[] => diagnose(site(root));
const at = (root: string, level: Finding["level"]): string[] =>
  all(root)
    .filter((f) => f.level === level)
    .map((f) => f.message);
const errors = (root: string): string => at(root, "error").join("\n");
const warnings = (root: string): string => at(root, "warning").join("\n");

const DOCS = ".github/workflows/docs.yml";
const PUBLISH = ".github/workflows/docs-publish.yml";

const AUTOMERGE = `name: Dependabot auto-merge
on: pull_request
jobs:
  auto-merge:
    runs-on: ubuntu-latest
    if: \${{ github.actor == 'dependabot[bot]' }}
    steps:
      - run: gh pr merge --auto --squash "$PR_URL"
`;

describe("a repository as init writes it", () => {
  test("has nothing to report but ok", async () => {
    const root = await initialisedRepo();
    expect(at(root, "error")).toEqual([]);
    expect(at(root, "warning")).toEqual([]);
    const messages = all(root).map((f) => f.message);
    expect(messages).toContain("config: valid (frappe-nix, frappe-nix.avunu.net)");
    expect(messages).toContain("docs: docs/ has a home page");
    expect(
      messages.some((m) => m.includes("docs.yml: docs-build.yml is pinned to a commit (v0.1.0)")),
    ).toBe(true);
    expect(messages).toContain("docs-site/package-lock.json is the lockfile");
    expect(messages.some((m) => m.includes("Dependabot watches /docs-site (npm)"))).toBe(true);
  });

  test("and so is one with a nested site folder", async () => {
    const root = makeRepo();
    await exec((ctx) => runInit(ctx, { resolvePin: () => ({ sha: SHA, reason: null }) }), {
      command: "init",
      cwd: root,
      options: { siteDir: "tools/docs-site", fromReadme: true },
    });
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "docs", "README.md"), "# Home\n");
    writeFileSync(join(root, "tools/docs-site/package-lock.json"), "{}\n");
    const findings = diagnose(join(root, "tools", "docs-site"));
    expect(findings.filter((f) => f.level !== "ok")).toEqual([]);
  });
});

describe("config", () => {
  test("a configuration that is not valid: every problem is an error", async () => {
    const root = await initialisedRepo();
    rewrite(root, "docs-site/docusystem.config.json", (text) =>
      text.replace('"tagline"', '"tagLine"').replace('"license": "MIT"', '"license": ""'),
    );
    const text = errors(root);
    expect(text).toMatch(/config: .*tagline/);
    expect(text).toMatch(/config: .*tagLine/);
    expect(text).toMatch(/config: .*license/);
    expect(at(root, "error").filter((m) => m.startsWith("config:")).length).toBeGreaterThanOrEqual(
      2,
    );
  });

  test("no configuration at all", async () => {
    const root = await initialisedRepo();
    rmSync(join(root, "docs-site", "docusystem.config.json"));
    expect(errors(root)).toMatch(/config: /);
  });

  test("a slug spelled differently from a catalog key is an error", async () => {
    const root = await initialisedRepo({ origin: "https://github.com/Avunu/erpnext_taskview" });
    expect(at(root, "error")).toEqual([]);
    rewrite(root, "docs-site/docusystem.config.json", (text) =>
      text.replace('"slug": "erpnext_taskview"', '"slug": "erpnext-taskview"'),
    );
    expect(errors(root)).toMatch(/config: .*erpnext_taskview/);
  });

  test("a slug that is not in the catalog is a warning", async () => {
    const root = await initialisedRepo();
    rewrite(root, "docs-site/docusystem.config.json", (text) =>
      text.replace('"slug": "frappe-nix"', '"slug": "brand-new-project"'),
    );
    expect(at(root, "error")).toEqual([]);
    expect(warnings(root)).toMatch(/config: .*brand-new-project/);
  });
});

describe("docs", () => {
  test("no home page is an error that says how to get one", async () => {
    const root = await initialisedRepo();
    rmSync(join(root, "docs", "README.md"));
    expect(errors(root)).toContain("docs: docs/ has no README.md, readme.md or index.md");
    expect(errors(root)).toContain("cp README.md docs/README.md");
    expect(errors(root)).toContain("docusystem init --from-readme");
  });

  test("a docs folder that does not exist has no home page either", async () => {
    const root = await initialisedRepo();
    rmSync(join(root, "docs"), { recursive: true });
    expect(errors(root)).toContain("docs: docs/ has no README.md");
  });

  test.each(["README.md", "readme.md", "index.md"])("%s is a home page", async (home) => {
    const root = await initialisedRepo();
    rmSync(join(root, "docs", "README.md"));
    writeFileSync(join(root, "docs", home), "# x\n");
    expect(at(root, "error")).toEqual([]);
  });

  test("a docs folder outside the repository is an error", async () => {
    const root = await initialisedRepo();
    rewrite(root, "docs-site/docusystem.config.json", (text) =>
      text.replace('"license": "MIT"', '"license": "MIT",\n  "docs": "../../outside"'),
    );
    expect(errors(root)).toMatch(/docs: .*outside the repository/);
  });

  test("a docs folder of another name is found from the config, and the callers must list it", async () => {
    const root = await initialisedRepo();
    mkdirSync(join(root, "documentation"));
    writeFileSync(join(root, "documentation", "README.md"), "# x\n");
    rewrite(root, "docs-site/docusystem.config.json", (text) =>
      text.replace('"license": "MIT"', '"license": "MIT",\n  "docs": "../documentation"'),
    );
    expect(errors(root)).not.toContain("docs: ");
    expect(errors(root)).toContain('on.pull_request.paths does not list "documentation/**"');
    expect(errors(root)).toContain('on.push.paths does not list "documentation/**"');
  });
});

describe("workflows", () => {
  test.each([DOCS, PUBLISH])("%s missing is an error", async (file) => {
    const root = await initialisedRepo();
    rmSync(join(root, file));
    expect(errors(root)).toContain(`${file} is missing: run \`docusystem init\``);
  });

  test("the starter's workflow does not call the reusable workflows", async () => {
    const root = await initialisedRepo();
    writeFileSync(join(root, DOCS), readFixture("starter-docs.yml"));
    expect(errors(root)).toContain(
      `${DOCS} does not call Avunu/docusystem/.github/workflows/docs-build.yml (a copy of the starter's workflow?)`,
    );
    expect(errors(root)).toContain("docusystem init --force");
  });

  test("a publish workflow that calls only the build is missing the deploy", async () => {
    const root = await initialisedRepo();
    rewrite(root, PUBLISH, (text) => text.slice(0, text.indexOf("\n  deploy:")));
    expect(errors(root)).toContain(
      "does not call Avunu/docusystem/.github/workflows/docs-deploy.yml",
    );
  });

  test("not valid YAML", async () => {
    const root = await initialisedRepo();
    writeFileSync(join(root, DOCS), "on: [unclosed\n");
    expect(errors(root)).toContain(`${DOCS} is not valid YAML`);
  });

  describe("the pin", () => {
    test.each(["v1", "main", "v0.1.0"])(
      "a call by %s is an error: a tag or a branch can move",
      async (ref) => {
        const root = await initialisedRepo();
        rewrite(root, DOCS, (text) => text.replace(`@${SHA} # v0.1.0`, `@${ref}`));
        expect(errors(root)).toContain(
          `${DOCS}: docs-build.yml is called by "${ref}", not by a commit`,
        );
      },
    );

    test("a short commit is not a commit either", async () => {
      const root = await initialisedRepo();
      rewrite(root, PUBLISH, (text) => text.replaceAll(SHA, SHA.slice(0, 7)));
      expect(errors(root)).toContain("not by a commit");
    });

    test("a version comment of another major is an error", async () => {
      const root = await initialisedRepo();
      rewrite(root, DOCS, (text) => text.replace("# v0.1.0", "# v1.2.0"));
      expect(errors(root)).toContain(
        "is pinned to v1.2.0 but 0.1.0 is installed, a different major",
      );
    });

    test("another minor or patch of the same major is a warning, and upgrade is named", async () => {
      const root = await initialisedRepo();
      rewrite(root, DOCS, (text) => text.replace("# v0.1.0", "# v0.0.9"));
      expect(at(root, "error")).toEqual([]);
      expect(warnings(root)).toContain(
        "is pinned to v0.0.9 and 0.1.0 is installed: fine within a major; `docusystem upgrade` aligns them",
      );
    });

    test("a pin without a version comment is a warning", async () => {
      const root = await initialisedRepo();
      rewrite(root, DOCS, (text) => text.replace(" # v0.1.0", ""));
      expect(at(root, "error")).toEqual([]);
      expect(warnings(root)).toContain('is pinned to a commit without a "# vX.Y.Z" comment');
    });
  });

  describe("triggers and permissions", () => {
    test("pull_request_target in docs.yml is an error", async () => {
      const root = await initialisedRepo();
      rewrite(root, DOCS, (text) => text.replace("  pull_request:", "  pull_request_target:"));
      expect(errors(root)).toContain(`${DOCS} is triggered by pull_request_target`);
    });

    test("workflow_run in docs-publish.yml is an error", async () => {
      const root = await initialisedRepo();
      rewrite(root, PUBLISH, (text) =>
        text.replace(
          "  workflow_dispatch:",
          "  workflow_dispatch:\n  workflow_run:\n    workflows: [Docs]\n    types: [completed]",
        ),
      );
      expect(errors(root)).toContain(`${PUBLISH} is triggered by workflow_run`);
    });

    test("a mention of the two in a comment is not a trigger", async () => {
      const root = await initialisedRepo();
      rewrite(
        root,
        DOCS,
        (text) => `# never use pull_request_target or workflow_run here\n${text}`,
      );
      expect(at(root, "error")).toEqual([]);
    });

    test("docs.yml that grants a write permission, at any level, is an error", async () => {
      const root = await initialisedRepo();
      rewrite(root, DOCS, (text) =>
        text.replace("contents: read # checkout", "contents: write # checkout"),
      );
      expect(errors(root)).toContain(`${DOCS} grants contents: write (job build)`);
      const top = await initialisedRepo();
      rewrite(top, DOCS, (text) => text.replace("permissions: {}", "permissions: write-all"));
      expect(errors(top)).toContain(`${DOCS} grants write-all: write`);
      const pages = await initialisedRepo();
      rewrite(pages, DOCS, (text) =>
        text.replace("permissions: {}", "permissions:\n  pages: write"),
      );
      expect(errors(pages)).toContain(`${DOCS} grants pages: write`);
    });

    test("docs-publish.yml without the DOCS_SITE_ENABLED gate on the deploy job is an error", async () => {
      const root = await initialisedRepo();
      rewrite(root, PUBLISH, (text) =>
        text.replace("    if: ${{ vars.DOCS_SITE_ENABLED == 'true' }}\n", ""),
      );
      expect(errors(root)).toContain(
        `${PUBLISH}: job deploy has no \`if: \${{ vars.DOCS_SITE_ENABLED == 'true' }}\` gate`,
      );
      // the variable in the build job's input is not the gate
      expect(readIn(root, PUBLISH)).toContain(
        "pages-artifact: ${{ vars.DOCS_SITE_ENABLED == 'true' }}",
      );
    });

    test.each(["pages", "id-token"])(
      "docs-publish.yml whose deploy job lacks %s: write is an error",
      async (name) => {
        const root = await initialisedRepo();
        rewrite(root, PUBLISH, (text) =>
          text
            .split("\n")
            .filter((line) => !line.includes(`${name}: write`))
            .join("\n"),
        );
        expect(errors(root)).toContain(`${PUBLISH}: job deploy does not grant ${name}: write`);
      },
    );

    test("docs-publish.yml that a pull request can trigger is an error: it holds pages: write", async () => {
      const root = await initialisedRepo();
      rewrite(root, PUBLISH, (text) =>
        text.replace("  workflow_dispatch:", "  pull_request:\n  workflow_dispatch:"),
      );
      expect(errors(root)).toContain(
        `${PUBLISH} is triggered by pull_request but asks for pages: write`,
      );
    });

    test("a literal branch is a warning", async () => {
      const root = await initialisedRepo();
      rewrite(root, PUBLISH, (text) =>
        text.replace("  push:\n", "  push:\n    branches: [main]\n"),
      );
      expect(at(root, "error")).toEqual([]);
      expect(warnings(root)).toContain(`${PUBLISH}: on.push.branches names main`);
    });
  });

  describe("agreement with the configuration", () => {
    test.each([DOCS, PUBLISH])("%s: another site-directory is an error", async (file) => {
      const root = await initialisedRepo();
      rewrite(root, file, (text) =>
        text.replaceAll("site-directory: docs-site", "site-directory: website"),
      );
      expect(errors(root)).toMatch(
        /builds site-directory "website" but the site folder is docs-site/,
      );
    });

    test("a build job without site-directory builds the default, which is right for docs-site only", async () => {
      const root = await initialisedRepo();
      rewrite(root, DOCS, (text) =>
        text.replace("    with:\n      site-directory: docs-site\n", ""),
      );
      expect(at(root, "error")).toEqual([]);
      const nested = makeRepo();
      await exec((ctx) => runInit(ctx, { resolvePin: () => ({ sha: SHA, reason: null }) }), {
        command: "init",
        cwd: nested,
        options: { siteDir: "tools/docs-site", fromReadme: true },
      });
      rewrite(nested, DOCS, (text) =>
        text.replace("    with:\n      site-directory: tools/docs-site\n", ""),
      );
      expect(
        diagnose(join(nested, "tools", "docs-site"))
          .filter((f) => f.level === "error")
          .map((f) => f.message)
          .join("\n"),
      ).toContain('builds site-directory "docs-site" but the site folder is tools/docs-site');
    });

    test.each([
      [DOCS, "pull_request"],
      [PUBLISH, "push"],
    ])("%s: a paths filter that lacks a folder is an error", async (file, event) => {
      const root = await initialisedRepo();
      rewrite(root, file, (text) => text.replace("- docs-site/**", "- website/**"));
      expect(errors(root)).toContain(`on.${event}.paths does not list "docs-site/**"`);
      const docs = await initialisedRepo();
      rewrite(docs, file, (text) => text.replace("- docs/**", "- guides/**"));
      expect(errors(docs)).toContain(`on.${event}.paths does not list "docs/**"`);
    });

    test("no paths filter at all disagrees with nothing", async () => {
      const root = await initialisedRepo();
      const bare = (text: string): string => text.replace(/\n {4}paths:\n(?: {6}- .*\n)+/, "\n");
      rewrite(root, DOCS, bare);
      expect(readIn(root, DOCS)).not.toContain("paths:");
      expect(at(root, "error")).toEqual([]);
    });
  });
});

describe("Dependabot", () => {
  const dependabot = ".github/dependabot.yml";
  const entries = {
    npmRoot: "  - package-ecosystem: npm\n    directory: /\n",
    npmSite: "  - package-ecosystem: npm\n    directory: /docs-site\n",
    bunSite: "  - package-ecosystem: bun\n    directory: /docs-site\n",
    actions: "  - package-ecosystem: github-actions\n    directory: /\n",
    actionsCooldown:
      "  - package-ecosystem: github-actions\n    directory: /\n    cooldown:\n      default-days: 7\n",
    actionsExcluded:
      "  - package-ecosystem: github-actions\n    directory: /\n    cooldown:\n      default-days: 7\n      exclude:\n        - Avunu/docusystem\n",
  };
  const withEntries = async (...parts: string[]): Promise<string> => {
    const root = await initialisedRepo();
    writeFileSync(join(root, dependabot), `version: 2\nupdates:\n${parts.join("")}`);
    return root;
  };

  test("no file: a warning for each of the two entries", async () => {
    const root = await initialisedRepo();
    rmSync(join(root, dependabot));
    expect(at(root, "error")).toEqual([]);
    const text = warnings(root);
    expect(text).toContain(
      ".github/dependabot.yml does not exist, so there is no npm entry for /docs-site",
    );
    expect(text).toContain(
      ".github/dependabot.yml does not exist, so there is no github-actions entry for /",
    );
  });

  test("a dependabot.yaml is read like a dependabot.yml", async () => {
    const root = await initialisedRepo();
    const text = readIn(root, dependabot) ?? "";
    rmSync(join(root, dependabot));
    writeFileSync(join(root, ".github/dependabot.yaml"), text);
    expect(at(root, "warning")).toEqual([]);
    expect(all(root).map((f) => f.message)).toContain(
      ".github/dependabot.yaml: Dependabot watches /docs-site (npm)",
    );
  });

  test("no npm entry for the site", async () => {
    const root = await withEntries(entries.npmRoot, entries.actions);
    expect(warnings(root)).toContain(".github/dependabot.yml has no npm entry for /docs-site");
    expect(warnings(root)).not.toContain("github-actions");
  });

  test("an npm entry for the root is not an entry for the site", async () => {
    const root = await withEntries(entries.npmRoot);
    expect(warnings(root)).toContain("has no npm entry for /docs-site");
  });

  test("the entry for the wrong ecosystem for the lockfile (bun with package-lock.json)", async () => {
    const root = await withEntries(entries.bunSite, entries.actions);
    expect(warnings(root)).toContain(
      "watches /docs-site as bun, but the site's lockfile is package-lock.json (ecosystem npm)",
    );
    expect(at(root, "error")).toEqual([]);
  });

  test("false OK of the judges: `npm /` followed by `bun /docs-site` is not an npm entry for the site", async () => {
    const root = await withEntries(entries.npmRoot, entries.bunSite, entries.actions);
    expect(warnings(root)).toContain("watches /docs-site as bun");
    expect(
      all(root)
        .filter((f) => f.level === "ok")
        .map((f) => f.message)
        .join("\n"),
    ).not.toContain("Dependabot watches /docs-site");
  });

  test("a bun lockfile makes bun the right ecosystem", async () => {
    const root = await withEntries(entries.bunSite, entries.actions);
    rmSync(join(root, "docs-site/package-lock.json"));
    writeFileSync(join(root, "docs-site/bun.lock"), "{}");
    expect(warnings(root)).not.toContain("watches /docs-site");
    expect(
      all(root)
        .map((f) => f.message)
        .join("\n"),
    ).toContain("Dependabot watches /docs-site (bun)");
  });

  test("no github-actions entry", async () => {
    const root = await withEntries(entries.npmSite);
    expect(warnings(root)).toContain("has no github-actions entry for /");
  });

  test("a github-actions entry for another directory is not the one for /", async () => {
    const root = await withEntries(
      entries.npmSite,
      "  - package-ecosystem: github-actions\n    directory: /sub\n",
    );
    expect(warnings(root)).toContain("has no github-actions entry for /");
  });

  test("a github-actions entry whose cooldown does not exclude the package's repository", async () => {
    const root = await withEntries(entries.npmSite, entries.actionsCooldown);
    expect(warnings(root)).toContain(
      "the github-actions entry has a cooldown that does not exclude Avunu/docusystem",
    );
    const fine = await withEntries(entries.npmSite, entries.actionsExcluded);
    expect(at(fine, "warning")).toEqual([]);
    const none = await withEntries(entries.npmSite, entries.actions);
    expect(at(none, "warning")).toEqual([]);
  });

  test("an npm entry with a cooldown that does not exclude the package", async () => {
    const root = await withEntries(
      "  - package-ecosystem: npm\n    directory: /docs-site\n    cooldown:\n      default-days: 7\n",
      entries.actions,
    );
    expect(warnings(root)).toContain(
      'the npm entry for /docs-site has a cooldown that does not exclude "@avunu/docusystem"',
    );
  });

  test("directories: lists are read", async () => {
    const root = await withEntries(
      "  - package-ecosystem: npm\n    directories: ['/', '/docs-site']\n",
      entries.actions,
    );
    expect(at(root, "warning")).toEqual([]);
  });

  test("a file that is not YAML is a warning, not a crash", async () => {
    const root = await initialisedRepo();
    writeFileSync(join(root, dependabot), "updates: [unclosed\n");
    expect(warnings(root)).toContain(".github/dependabot.yml cannot be read");
    expect(at(root, "error")).toEqual([]);
  });
});

describe("the auto-merge workflow", () => {
  const file = ".github/workflows/dependabot-auto-merge.yml";

  test("one that merges Dependabot's pull requests without skipping the site's is an error", async () => {
    const root = await initialisedRepo();
    writeFileSync(join(root, file), AUTOMERGE);
    expect(errors(root)).toContain(
      `${file} merges Dependabot's pull requests but does not skip the site's`,
    );
    expect(errors(root)).toContain(
      "!startsWith(github.head_ref, 'dependabot/npm_and_yarn/docs-site')",
    );
    // init would do it, and says so
    expect(errors(root)).toContain("(`docusystem init` does)");
  });

  test("a shape init cannot patch: no promise that init does it, and the finished line to paste", async () => {
    const root = await initialisedRepo();
    writeFileSync(
      join(root, file),
      AUTOMERGE.replace(
        "if: ${{ github.actor == 'dependabot[bot]' }}",
        `if: "github.actor == 'dependabot[bot]'"`,
      ),
    );
    const message = errors(root);
    expect(message).toContain(
      `${file} merges Dependabot's pull requests but does not skip the site's`,
    );
    expect(message).not.toContain("`docusystem init` does");
    expect(message).toContain("`docusystem init` cannot patch it");
    expect(message).toContain("line 6: `github.actor == 'dependabot[bot]'`");
    expect(message).toContain(
      "if: ${{ github.actor == 'dependabot[bot]' && !startsWith(github.head_ref, 'dependabot/npm_and_yarn/docs-site') && !startsWith(github.head_ref, 'dependabot/github_actions/') }}",
    );
  });

  test("the pull request author's condition, the form zizmor recommends, is patched by init and so promised", async () => {
    const root = await initialisedRepo();
    writeFileSync(
      join(root, file),
      AUTOMERGE.replace(
        "github.actor == 'dependabot[bot]'",
        "github.event.pull_request.user.login == 'dependabot[bot]'",
      ),
    );
    expect(errors(root)).toContain("(`docusystem init` does)");
  });

  test("false OK of the judges: an exclusion of the bun branches does not count", async () => {
    const root = await initialisedRepo();
    writeFileSync(
      join(root, file),
      AUTOMERGE.replace(
        "'dependabot[bot]' }}",
        "'dependabot[bot]' && !startsWith(github.head_ref, 'dependabot/bun/docs-site') }}",
      ),
    );
    expect(errors(root)).toContain(
      `${file} excludes dependabot/bun/docs-site, but the site's lockfile makes Dependabot's ecosystem npm`,
    );
  });

  test("an exclusion of the site's npm branches alone is an error: the pin of the shared workflows moves in a github-actions pull request", async () => {
    const root = await initialisedRepo();
    writeFileSync(
      join(root, file),
      AUTOMERGE.replace(
        "'dependabot[bot]' }}",
        "'dependabot[bot]' && !startsWith(github.head_ref, 'dependabot/npm_and_yarn/docs-site') }}",
      ),
    );
    expect(errors(root)).toContain(`${file} does not skip the github-actions pull requests`);
    expect(errors(root)).toContain("move the commit pin of the shared workflows");
    expect(errors(root)).toContain(
      "add !startsWith(github.head_ref, 'dependabot/github_actions/') to the condition",
    );
    expect(at(root, "error")).toHaveLength(1);
  });

  test("an exclusion of the github-actions branches alone is the site's error", async () => {
    const root = await initialisedRepo();
    writeFileSync(
      join(root, file),
      AUTOMERGE.replace(
        "'dependabot[bot]' }}",
        "'dependabot[bot]' && !startsWith(github.head_ref, 'dependabot/github_actions/') }}",
      ),
    );
    expect(errors(root)).toContain("does not skip the site's");
    expect(errors(root)).not.toContain("also,");
  });

  test("a workflow that skips neither is told both, and a bun exclusion also gets the pin", async () => {
    const root = await initialisedRepo();
    writeFileSync(join(root, file), AUTOMERGE);
    expect(errors(root)).toContain("also, Dependabot's github-actions pull requests move");
    writeFileSync(
      join(root, file),
      AUTOMERGE.replace(
        "'dependabot[bot]' }}",
        "'dependabot[bot]' && !startsWith(github.head_ref, 'dependabot/bun/docs-site') }}",
      ),
    );
    expect(errors(root)).toContain("also, Dependabot's github-actions pull requests move");
  });

  test("an exclusion of exactly the site's npm branches and of the github-actions ones is ok", async () => {
    const root = await initialisedRepo();
    writeFileSync(
      join(root, file),
      AUTOMERGE.replace(
        "'dependabot[bot]' }}",
        "'dependabot[bot]' && !startsWith(github.head_ref, 'dependabot/npm_and_yarn/docs-site') && !startsWith(github.head_ref, 'dependabot/github_actions/') }}",
      ),
    );
    expect(at(root, "error")).toEqual([]);
    expect(all(root).map((f) => f.message)).toContain(
      `${file}: leaves the site's and the shared workflows' Dependabot pull requests to a person`,
    );
  });

  test("an exclusion of another folder is not the site's", async () => {
    const root = await initialisedRepo();
    writeFileSync(
      join(root, file),
      AUTOMERGE.replace(
        "'dependabot[bot]' }}",
        "'dependabot[bot]' && !startsWith(github.head_ref, 'dependabot/npm_and_yarn/docs') }}",
      ),
    );
    expect(errors(root)).toContain("does not skip the site's");
  });

  test("a comment that names the branch is not an exclusion", async () => {
    const root = await initialisedRepo();
    writeFileSync(
      join(root, file),
      `# !startsWith(github.head_ref, 'dependabot/npm_and_yarn/docs-site')\n${AUTOMERGE}`,
    );
    expect(errors(root)).toContain("does not skip the site's");
  });

  test("a workflow that does not merge Dependabot's pull requests is not an auto-merge workflow", async () => {
    const root = await initialisedRepo();
    writeFileSync(
      join(root, ".github/workflows/check.yml"),
      "name: Check\non: pull_request\njobs:\n  a:\n    if: github.actor != 'dependabot[bot]'\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n",
    );
    expect(at(root, "error")).toEqual([]);
    expect(all(root).map((f) => f.message)).toContain(
      "no Dependabot auto-merge workflow to adjust",
    );
  });

  const FOLDED = AUTOMERGE.replace(
    "if: ${{ github.actor == 'dependabot[bot]' }}",
    [
      "if: >-",
      "      github.event.pull_request.user.login == 'dependabot[bot]' &&",
      "      github.repository == 'Avunu/frappe-nix'",
    ].join("\n"),
  );

  test.each([
    ["the standard condition", AUTOMERGE],
    [
      "the pull request author's condition",
      AUTOMERGE.replace(
        "github.actor == 'dependabot[bot]'",
        "github.event.pull_request.user.login == 'dependabot[bot]'",
      ),
    ],
    ["a folded multi-line condition", FOLDED],
  ])("what init patches, doctor accepts: %s", async (_shape, workflow) => {
    const root = makeRepo({ files: { [file]: workflow } });
    await exec((ctx) => runInit(ctx, { resolvePin: () => ({ sha: SHA, reason: null }) }), {
      command: "init",
      cwd: root,
    });
    writeFileSync(join(root, "docs-site/package-lock.json"), "{}\n");
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "docs/README.md"), "# x\n");
    expect(at(root, "error")).toEqual([]);
    expect(all(root).map((f) => f.message)).toContain(
      `${file}: leaves the site's and the shared workflows' Dependabot pull requests to a person`,
    );
  });

  test("a folded multi-line condition is an error with the promise that init does it", async () => {
    const root = await initialisedRepo();
    writeFileSync(join(root, file), FOLDED);
    expect(errors(root)).toContain("(`docusystem init` does)");
  });
});

describe("the lockfile", () => {
  test.each(["bun.lock", "bun.lockb"])("%s is an error", async (name) => {
    const root = await initialisedRepo();
    writeFileSync(join(root, "docs-site", name), "");
    expect(errors(root)).toContain(
      `docs-site/${name} exists: the shared workflow refuses Bun lockfiles`,
    );
  });

  test("none is an error", async () => {
    const root = await initialisedRepo();
    rmSync(join(root, "docs-site/package-lock.json"));
    expect(errors(root)).toContain("docs-site/ has no package-lock.json");
  });

  test("a bun lockfile alone is the bun error only", async () => {
    const root = await initialisedRepo();
    rmSync(join(root, "docs-site/package-lock.json"));
    writeFileSync(join(root, "docs-site/bun.lock"), "{}");
    expect(errors(root)).toContain("docs-site/bun.lock exists");
    expect(errors(root)).not.toContain("has no package-lock.json");
    expect(errors(root)).not.toContain("has both");
  });

  test("both is an error", async () => {
    const root = await initialisedRepo();
    writeFileSync(join(root, "docs-site/bun.lock"), "{}");
    expect(errors(root)).toContain(
      "docs-site/ has both package-lock.json and bun.lock: keep package-lock.json only",
    );
  });
});

describe("overrides", () => {
  const withOverrides = async (): Promise<string> => {
    const root = await initialisedRepo();
    mkdirSync(join(root, "docs-site/overrides/components"), { recursive: true });
    writeFileSync(join(root, "docs-site/overrides/components/docs-footer.json"), "{}\n");
    return root;
  };

  test("none: nothing to say but ok", async () => {
    const root = await initialisedRepo();
    expect(all(root).map((f) => f.message)).toContain(
      "overrides: none; the site follows the package",
    );
    expect(overrideFindings).not.toHaveBeenCalled();
  });

  test("the jx setting is not 'none': it is a warning, with or without an overrides folder", async () => {
    const root = await initialisedRepo();
    rewrite(root, "docs-site/docusystem.config.json", (text) =>
      text.replace(
        /\n}\n$/,
        ',\n  "jx": { "$head": [{ "tagName": "meta", "attributes": { "name": "author", "content": "Avunu" } }] }\n}\n',
      ),
    );
    const message =
      'overrides: the "jx" setting of docusystem.config.json (merged into project.json) is outside semver and does not follow package updates: check the pages it changes after each upgrade';
    expect(at(root, "error")).toEqual([]);
    expect(warnings(root)).toContain(message);
    expect(all(root).map((f) => f.message)).not.toContain(
      "overrides: none; the site follows the package",
    );

    mkdirSync(join(root, "docs-site/overrides/components"), { recursive: true });
    writeFileSync(join(root, "docs-site/overrides/components/docs-footer.json"), "{}\n");
    vi.mocked(overrideFindings).mockReturnValueOnce([
      { level: "ok", message: "overrides/components/docs-footer.json is current" },
    ]);
    const findings = all(root);
    expect(findings).toContainEqual({ level: "warning", message });
    expect(findings).toContainEqual({
      level: "ok",
      message: "overrides/components/docs-footer.json is current",
    });
  });

  test("what the assemble package finds is reported with its levels", async () => {
    const root = await withOverrides();
    vi.mocked(overrideFindings).mockReturnValueOnce([
      { level: "ok", message: "overrides/components/a.json is current" },
      {
        level: "warning",
        message: "overrides/components/b.json was copied from 0.1.0: the package's file changed",
      },
      {
        level: "warning",
        message: "overrides/components/c.json replaces a package file but was not made with eject",
      },
      {
        level: "error",
        message: "overrides/components/d.json was ejected from a file the package no longer ships",
      },
    ]);
    const findings = all(root);
    for (const expected of [
      { level: "ok", message: "overrides/components/a.json is current" },
      {
        level: "warning",
        message: "overrides/components/b.json was copied from 0.1.0: the package's file changed",
      },
      {
        level: "warning",
        message: "overrides/components/c.json replaces a package file but was not made with eject",
      },
      {
        level: "error",
        message: "overrides/components/d.json was ejected from a file the package no longer ships",
      },
    ]) {
      expect(findings).toContainEqual(expected);
    }
  });

  test("a failing check is an error, not a crash", async () => {
    const root = await withOverrides();
    vi.mocked(overrideFindings).mockImplementationOnce(() => {
      throw new Error("overrides/.ejected.json is not JSON");
    });
    expect(errors(root)).toContain(
      "overrides: cannot be checked (overrides/.ejected.json is not JSON)",
    );
  });
});

describe("the rest of the repository", () => {
  test("a pre-commit copyright hook is a warning", async () => {
    const root = await initialisedRepo();
    writeFileSync(
      join(root, ".pre-commit-config.yaml"),
      "repos:\n  - repo: local\n    hooks:\n      - id: Copyright\n        name: add a copyright stamp\n",
    );
    expect(warnings(root)).toContain(
      ".pre-commit-config.yaml has a copyright hook: exclude ^docs/ from it",
    );
    const plain = await initialisedRepo();
    writeFileSync(join(plain, ".pre-commit-config.yaml"), "repos: []\n");
    expect(at(plain, "warning")).toEqual([]);
  });

  test("leftovers of the starter in the site folder are a warning", async () => {
    const root = await initialisedRepo();
    for (const name of ["components", "layouts", "pages", "scripts"])
      mkdirSync(join(root, "docs-site", name));
    writeFileSync(join(root, "docs-site", "project.json"), "{}");
    expect(warnings(root)).toContain(
      "docs-site/ has components, layouts, pages, project.json, scripts: leftovers of the copied starter",
    );
  });

  test("a package.json that is the starter's: a postinstall script or a Jx dependency is a warning", async () => {
    const root = await initialisedRepo();
    writeFileSync(
      join(root, "docs-site/package.json"),
      JSON.stringify({
        scripts: { postinstall: "bun scripts/postinstall.ts" },
        dependencies: { "@jxsuite/compiler": "^5.0.0" },
        devDependencies: { "@jxsuite/server": "^4.4.3" },
      }),
    );
    expect(at(root, "error")).toEqual([]);
    expect(warnings(root)).toContain(
      "docs-site/package.json has a postinstall script, a dependency on @jxsuite/compiler, a dependency on @jxsuite/server: it is a copy of the starter",
    );
    const fine = await initialisedRepo();
    expect(warnings(fine)).toBe("");
    // a package.json that cannot be read is not this check's business
    writeFileSync(join(fine, "docs-site/package.json"), "{ nope");
    expect(warnings(fine)).toBe("");
  });

  test("a formatter configuration is only mentioned", async () => {
    const root = await initialisedRepo();
    writeFileSync(join(root, ".oxfmtrc.json"), "{}");
    writeFileSync(join(root, ".prettierrc"), "{}");
    expect(at(root, "warning")).toEqual([]);
    expect(at(root, "error")).toEqual([]);
    const note = all(root).find((f) => f.message.startsWith("note: "));
    expect(note?.level).toBe("ok");
    expect(note?.message).toContain(
      ".oxfmtrc.json, .prettierrc may reformat the Markdown of docs/",
    );
    // and that it checks the shell as well: the folder it can be told to ignore is named
    expect(note?.message).toContain("also checks docs-site/ and the caller workflows");
    expect(note?.message).toContain("ignore docs-site in its configuration");
  });
});

describe.each(PILOTS)("init, then doctor, in a copy of %s's .github", (pilot) => {
  test("no errors; the only warning is a github-actions cooldown that init leaves to a person (the package is never held back)", async () => {
    const root = makeRepo({
      origin: `https://github.com/Avunu/${pilot}`,
      files: {
        "README.md": "# x\n",
        ".github/workflows/docs.yml": readFixture("starter-docs.yml"),
      },
    });
    copyPilotGithub(root, pilot);
    const done = await exec(
      (ctx) => runInit(ctx, { resolvePin: () => ({ sha: SHA, reason: null }) }),
      {
        command: "init",
        cwd: root,
        options: { force: true, fromReadme: true },
      },
    );
    expect(done.code).toBe(0);
    writeFileSync(join(root, "docs-site/package-lock.json"), "{}\n");
    expect(at(root, "error")).toEqual([]);
    const found = at(root, "warning");
    expect(found.filter((warning) => warning.includes("@avunu/docusystem"))).toEqual([]);
    expect(found).toHaveLength(pilot === "erpnext_taskview" ? 1 : 0);
    for (const warning of found)
      expect(warning).toContain(
        "the github-actions entry has a cooldown that does not exclude Avunu/docusystem",
      );
  });
});

describe("the command", () => {
  test("prints a line for each finding, a summary and the settings of GitHub, DNS and avunu.net; exit 0", async () => {
    const root = await initialisedRepo();
    const { code, out, err } = await exec(run, { command: "doctor", cwd: root });
    expect(err).toBe("");
    expect(code).toBe(0);
    expect(out).toContain("ok       config: valid (frappe-nix, frappe-nix.avunu.net)");
    expect(out).toContain("doctor: no errors");
    expect(out).toContain("A maintainer still has to (none of it can be checked from a clone):");
    expect(out).toContain("Custom domain: frappe-nix.avunu.net");
    expect(out).toContain("DOCS_SITE_ENABLED = true");
    expect(out).toContain("Verify avunu.net once for the Avunu GitHub organization");
    expect(out).toContain("when the site is retired or its domain changes");
  });

  test("warnings do not fail it; errors do", async () => {
    const root = await initialisedRepo();
    rewrite(root, DOCS, (text) => text.replace(" # v0.1.0", ""));
    const warned = await exec(run, { command: "doctor", cwd: root });
    expect(warned.code).toBe(0);
    expect(warned.out).toContain("warning  ");
    expect(warned.out).toMatch(/doctor: no errors, 1 warning\n/);
    rmSync(join(root, "docs", "README.md"));
    const failed = await exec(run, { command: "doctor", cwd: root });
    expect(failed.code).toBe(1);
    expect(failed.out).toContain("error    docs: docs/ has no README.md");
    expect(failed.out).toMatch(/doctor: 1 error, 1 warning/);
  });

  test("--json", async () => {
    const root = await initialisedRepo();
    rmSync(join(root, "docs", "README.md"));
    const { code, out } = await exec(run, {
      command: "doctor",
      cwd: root,
      options: { json: true },
    });
    expect(code).toBe(1);
    const report = JSON.parse(out) as {
      ok: boolean;
      errors: number;
      warnings: number;
      findings: Finding[];
      maintainer: string[];
    };
    expect(report.ok).toBe(false);
    expect(report.errors).toBe(1);
    expect(report.warnings).toBe(0);
    expect(report.findings.filter((f) => f.level === "error")).toHaveLength(1);
    expect(report.maintainer.join("\n")).toContain("DOCS_SITE_ENABLED");
  });

  test("an invalid configuration: errors, no settings to print", async () => {
    const root = await initialisedRepo();
    writeFileSync(join(root, "docs-site/docusystem.config.json"), "{}");
    const { code, out } = await exec(run, { command: "doctor", cwd: root });
    expect(code).toBe(1);
    expect(out).toContain("error    config:");
    expect(out).not.toContain("A maintainer still has to");
  });

  test("no site folder: exit 1 and where it looked", async () => {
    const root = makeRepo();
    const { code, err } = await exec(run, { command: "doctor", cwd: root });
    expect(code).toBe(1);
    expect(err).toContain("docusystem: doctor:");
    expect(err).toContain("docusystem.config.json");
  });

  test("colors the level word when the terminal can show them", async () => {
    const root = await initialisedRepo();
    const { ctx, stdout } = testContext({
      command: "doctor",
      cwd: root,
      env: envFor(root),
      color: true,
    });
    await run(ctx);
    expect(stdout[0]).toContain("\u001B[32mok     \u001B[0m");
  });

  test("docusystem doctor --json from the command line", async () => {
    const root = await initialisedRepo();
    const result = await runCli(["doctor", "--json", "--site", join(root, "docs-site")], {
      cwd: root,
      env: envFor(root),
    });
    expect(result.code).toBe(0);
    expect((JSON.parse(result.stdout) as { ok: boolean }).ok).toBe(true);
  });
});
