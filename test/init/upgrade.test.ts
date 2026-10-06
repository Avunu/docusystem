// `docusystem upgrade` (4.1, 7.6): re-pins both callers, appends missing Dependabot entries, changes
// nothing else.
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { runInit } from "../../src/commands/init.js";
import { runUpgrade, type UpgradeDeps } from "../../src/commands/upgrade.js";
import { listTree, runCli, tempDir } from "../support/index.js";
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
  SHA2,
  SHELL_FILES,
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
vi.mock("../../src/lib/package-info.js", (original) =>
  import("./support/neighbours.js").then((m) => m.mockPackageInfo(original)),
);

const PIN: UpgradeDeps = { resolvePin: () => ({ sha: SHA2, reason: null }) };
const OFFLINE: UpgradeDeps = {
  resolvePin: () => ({
    sha: null,
    reason: "could not ask Avunu/docusystem for the tag v0.1.0 (offline)",
  }),
};

const upgrade = (
  cwd: string,
  options: Parameters<typeof exec>[1]["options"] = {},
  deps: UpgradeDeps = PIN,
) => exec((ctx) => runUpgrade(ctx, deps), { command: "upgrade", cwd, options });

/** A repository whose callers are pinned to an older release. */
async function oldPins() {
  const root = await initialisedRepo();
  for (const file of ["docs.yml", "docs-publish.yml"]) {
    rewrite(root, `.github/workflows/${file}`, (text) =>
      text.replaceAll(SHA, "a".repeat(40)).replaceAll("v0.1.0", "v0.0.9"),
    );
  }
  return root;
}

const others = (root: string): Record<string, string | null> =>
  Object.fromEntries(
    SHELL_FILES.filter((file) => !file.includes("workflows/")).map((file) => [
      file,
      readIn(root, file),
    ]),
  );

describe("upgrade", () => {
  test("rewrites the commit and the version of every uses line of both callers, and nothing else", async () => {
    const root = await oldPins();
    const before = others(root);
    const { code, out, err } = await upgrade(root);
    expect(err).toBe("");
    expect(code).toBe(0);
    for (const file of ["docs.yml", "docs-publish.yml"]) {
      const text = readIn(root, `.github/workflows/${file}`) ?? "";
      expect(text).not.toContain("a".repeat(40));
      expect(text).not.toContain("v0.0.9");
      for (const line of text.split("\n").filter((l) => l.includes("uses:"))) {
        expect(line).toMatch(new RegExp(`@${SHA2} # v0\\.1\\.0$`));
      }
    }
    // the callers are what init would write for that commit: only the pins differed
    expect(readIn(root, ".github/workflows/docs.yml")).toBe(
      readFixture("example-shell", ".github", "workflows", "docs.yml").replaceAll(SHA, SHA2),
    );
    expect(readIn(root, ".github/workflows/docs-publish.yml")).toBe(
      readFixture("example-shell", ".github", "workflows", "docs-publish.yml").replaceAll(
        SHA,
        SHA2,
      ),
    );
    expect(others(root)).toEqual(before);
    expect(out).toContain("upgrade: changed 2 files; pins are v0.1.0 (fedcba987654)");
    expect(out).toContain("updated  .github/workflows/docs.yml  (pinned to v0.1.0)");
    expect(out).toContain("Next: run `docusystem doctor`");
  });

  test("only the pins change in a caller that someone added lines to", async () => {
    const root = await oldPins();
    rewrite(root, ".github/workflows/docs.yml", (text) => `${text}\n# my note\n`);
    await upgrade(root);
    expect(readIn(root, ".github/workflows/docs.yml")).toBe(
      `${readFixture("example-shell", ".github", "workflows", "docs.yml").replaceAll(SHA, SHA2)}\n# my note\n`,
    );
  });

  test("run again, it has nothing to change", async () => {
    const root = await oldPins();
    await upgrade(root);
    const before = listTree(root);
    const { code, out } = await upgrade(root);
    expect(code).toBe(0);
    expect(out).toContain(
      "upgrade: nothing to change: the workflows are pinned to v0.1.0 (fedcba987654)",
    );
    expect(listTree(root)).toEqual(before);
  });

  test("--dry-run writes nothing and shows the diff", async () => {
    const root = await oldPins();
    const before = readIn(root, ".github/workflows/docs.yml");
    const { code, out } = await upgrade(root, { dryRun: true });
    expect(code).toBe(0);
    expect(readIn(root, ".github/workflows/docs.yml")).toBe(before);
    expect(out).toContain("upgrade (dry run): would change 2 files");
    expect(out).toContain("would update  .github/workflows/docs.yml");
    expect(out).toContain("--- a/.github/workflows/docs.yml\n+++ b/.github/workflows/docs.yml");
    expect(out).toContain(
      `+    uses: Avunu/docusystem/.github/workflows/docs-build.yml@${SHA2} # v0.1.0`,
    );
  });

  test("a commit that cannot be found: exit 1, names --workflow-sha, nothing changed", async () => {
    const root = await oldPins();
    const before = listTree(root);
    const text = readIn(root, ".github/workflows/docs.yml");
    const { code, err } = await upgrade(root, {}, OFFLINE);
    expect(code).toBe(1);
    expect(err).toContain("could not find the commit of the tag v0.1.0");
    expect(err).toContain("--workflow-sha");
    expect(err).toContain("Nothing was changed");
    expect(listTree(root)).toEqual(before);
    expect(readIn(root, ".github/workflows/docs.yml")).toBe(text);
  });

  test("--workflow-sha needs no lookup", async () => {
    const root = await oldPins();
    const { code } = await upgrade(root, { workflowSha: SHA }, OFFLINE);
    expect(code).toBe(0);
    expect(readIn(root, ".github/workflows/docs.yml")).toContain(`@${SHA} # v0.1.0`);
    const bad = await upgrade(root, { workflowSha: "abc" }, OFFLINE);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("--workflow-sha must be a full 40-character commit id");
  });

  test("a caller that is missing is reported, the other one is pinned", async () => {
    const root = await oldPins();
    rmSync(join(root, ".github/workflows/docs-publish.yml"));
    const { code, out } = await upgrade(root);
    expect(code).toBe(0);
    expect(readIn(root, ".github/workflows/docs.yml")).toContain(`@${SHA2} # v0.1.0`);
    expect(out).toContain(
      ".github/workflows/docs-publish.yml does not exist: run `docusystem init`",
    );
    expect(existsSync(join(root, ".github/workflows/docs-publish.yml"))).toBe(false);
  });

  test("a caller that is the starter's workflow is not touched, and init --force is named", async () => {
    const root = await oldPins();
    writeFileSync(join(root, ".github/workflows/docs.yml"), readFixture("starter-docs.yml"));
    const { code, out } = await upgrade(root);
    expect(code).toBe(0);
    expect(readIn(root, ".github/workflows/docs.yml")).toBe(readFixture("starter-docs.yml"));
    expect(out).toContain("does not call a reusable workflow of Avunu/docusystem");
    expect(out).toContain("docusystem init --force");
  });

  test("refuses to write through a symbolic link, and changes nothing", async () => {
    const root = await oldPins();
    const elsewhere = tempDir();
    const publish = join(root, ".github/workflows/docs-publish.yml");
    const original = readFileSync(publish, "utf8");
    writeFileSync(join(elsewhere, "target.yml"), original);
    rmSync(publish);
    symlinkSync(join(elsewhere, "target.yml"), publish);
    const before = readIn(root, ".github/workflows/docs.yml");
    const { code, err } = await upgrade(root);
    expect(code).toBe(1);
    expect(err).toContain("refusing to write .github/workflows/docs-publish.yml");
    expect(err).toContain("is a symbolic link");
    expect(err).toContain("Nothing was changed");
    expect(readIn(root, ".github/workflows/docs.yml")).toBe(before);
    expect(readFileSync(join(elsewhere, "target.yml"), "utf8")).toBe(original);
  });

  test("a tag in a caller is replaced by the commit", async () => {
    const root = await oldPins();
    rewrite(root, ".github/workflows/docs.yml", (text) =>
      text.replace(/@[0-9a-f]{40} # v0\.0\.9/g, "@v1"),
    );
    await upgrade(root);
    expect(readIn(root, ".github/workflows/docs.yml")).toContain(`docs-build.yml@${SHA2} # v0.1.0`);
  });
});

describe("upgrade: Dependabot", () => {
  test("appends the entries that are missing to the file the repository has", async () => {
    const root = await oldPins();
    const only =
      "# mine\nversion: 2\nupdates:\n  - package-ecosystem: pip\n    directory: /\n    schedule:\n      interval: daily\n";
    writeFileSync(join(root, ".github/dependabot.yml"), only);
    const { out } = await upgrade(root);
    const text = readIn(root, ".github/dependabot.yml") ?? "";
    expect(text.startsWith(only)).toBe(true);
    expect(text).toContain("package-ecosystem: npm\n    directory: /docs-site");
    expect(text).toContain("package-ecosystem: github-actions");
    expect(out).toContain(
      "updated  .github/dependabot.yml  (added the npm entry for /docs-site; added the github-actions entry for /)",
    );
  });

  test("converts a bun entry of the site to npm", async () => {
    const root = makeRepo({
      files: {
        "docs-site/docusystem.config.json": readFixture(
          "example-shell",
          "docs-site",
          "docusystem.config.json",
        ),
      },
    });
    copyPilotGithub(root, "frappe-nix");
    writeFileSync(
      join(root, ".github/workflows/docs.yml"),
      readFixture("example-shell", ".github", "workflows", "docs.yml"),
    );
    const { code } = await upgrade(root);
    expect(code).toBe(0);
    const text = readIn(root, ".github/dependabot.yml") ?? "";
    expect(text).toContain("- package-ecosystem: npm\n    directory: /docs-site");
    expect(text).not.toContain("package-ecosystem: bun");
  });

  test("a repository without a dependabot.yml does not get one", async () => {
    const root = await oldPins();
    rmSync(join(root, ".github/dependabot.yml"));
    const { code, out } = await upgrade(root);
    expect(code).toBe(0);
    expect(existsSync(join(root, ".github/dependabot.yml"))).toBe(false);
    expect(out).toContain(".github/dependabot.yml does not exist: nothing to add");
  });

  test("a file it cannot edit safely: left alone, the snippet printed, the pins still updated", async () => {
    const root = await oldPins();
    writeFileSync(join(root, ".github/dependabot.yml"), "version: 2\nupdates: [unclosed\n");
    const { code, out } = await upgrade(root);
    expect(code).toBe(0);
    expect(readIn(root, ".github/dependabot.yml")).toBe("version: 2\nupdates: [unclosed\n");
    expect(out).toContain("is not valid YAML");
    expect(out).toContain("package-ecosystem: npm");
    expect(readIn(root, ".github/workflows/docs.yml")).toContain(SHA2);
  });
});

describe("upgrade: finding the site", () => {
  test("from inside the site folder and with --site", async () => {
    const root = await oldPins();
    expect((await upgrade(join(root, "docs-site"))).code).toBe(0);
    expect(readIn(root, ".github/workflows/docs.yml")).toContain(SHA2);
    const other = await oldPins();
    const elsewhere = join(other, "docs");
    expect((await upgrade(elsewhere, { site: join(other, "docs-site") })).code).toBe(0);
    expect(readIn(other, ".github/workflows/docs.yml")).toContain(SHA2);
  });

  test("a folder without a site is an error that says what was searched", async () => {
    const root = makeRepo();
    const { code, err } = await upgrade(root);
    expect(code).toBe(1);
    expect(err).toContain("docusystem.config.json");
  });

  test("a site folder in a nested place is watched at its own directory", async () => {
    const root = makeRepo();
    const done = await exec(
      (ctx) => runInit(ctx, { resolvePin: () => ({ sha: SHA, reason: null }) }),
      {
        command: "init",
        cwd: root,
        options: { siteDir: "tools/docs-site" },
      },
    );
    expect(done.code).toBe(0);
    writeFileSync(
      join(root, ".github/dependabot.yml"),
      "version: 2\nupdates:\n  - package-ecosystem: pip\n    directory: /\n",
    );
    const { code } = await upgrade(join(root, "tools", "docs-site"));
    expect(code).toBe(0);
    expect(readIn(root, ".github/workflows/docs.yml")).toContain(`@${SHA2} # v0.1.0`);
    expect(readIn(root, ".github/dependabot.yml")).toContain(
      "package-ecosystem: npm\n    directory: /tools/docs-site",
    );
  });
});

describe.each(PILOTS)("upgrade in a copy of %s's .github", (pilot) => {
  test("the bun entry becomes npm and excludes the package from its cooldown", async () => {
    const root = makeRepo({
      origin: `https://github.com/Avunu/${pilot}`,
      files: {
        "docs-site/docusystem.config.json": readFixture(
          "example-shell",
          "docs-site",
          "docusystem.config.json",
        ),
      },
    });
    copyPilotGithub(root, pilot);
    mkdirSync(join(root, ".github/workflows"), { recursive: true });
    writeFileSync(
      join(root, ".github/workflows/docs.yml"),
      readFixture("example-shell", ".github", "workflows", "docs.yml"),
    );
    const before = readIn(root, ".github/dependabot.yml") ?? "";
    const { out } = await upgrade(root);
    const after = readIn(root, ".github/dependabot.yml") ?? "";
    expect(after).toContain("  - package-ecosystem: npm\n    directory: /docs-site");
    expect(after).toContain(
      '    cooldown:\n      default-days: 7\n      exclude:\n        - "@avunu/docusystem"\n',
    );
    expect(after.split("\n")).toHaveLength(before.split("\n").length + 2);
    expect(out).toContain("excluded @avunu/docusystem from the cooldown");
    expect(out.includes("the github-actions entry has a cooldown")).toBe(
      pilot === "erpnext_taskview",
    );
  });
});

describe("the command line", () => {
  test("docusystem upgrade --dry-run --workflow-sha", async () => {
    const root = await oldPins();
    const result = await runCli(["upgrade", "--dry-run", "--workflow-sha", SHA2], {
      cwd: root,
      env: envFor(root),
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("would change 2 files");
  });
});
