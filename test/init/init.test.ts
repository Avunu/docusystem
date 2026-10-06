// `docusystem init` (4.1.2): inference from `origin` and the catalog, where it runs, what it writes,
// what it refuses, and that running it again changes nothing. The catalog and the config module are
// the fakes of ./support/neighbours.ts until WP1 is merged; the release version is fixed to 0.1.0.
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { decide, runInit, type InitDeps } from "../../src/commands/init.js";
import { readBundledCatalog } from "../../src/lib/catalog.js";
import { listTree, runCli, tempDir } from "../support/index.js";
import { readFixture } from "./support/fixtures.js";
import {
  copyPilotGithub,
  envFor,
  exec,
  makeRepo,
  PILOTS,
  readIn,
  SHA,
  SHA2,
  SHELL_FILES,
  worktree,
} from "./support/shell.js";

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

const PIN: InitDeps = { resolvePin: () => ({ sha: SHA, reason: null }) };
const OFFLINE: InitDeps = {
  resolvePin: () => ({
    sha: null,
    reason: "could not ask Avunu/docusystem for the tag v0.1.0 (offline)",
  }),
};
const NEVER: InitDeps = {
  resolvePin: () => {
    throw new Error("the release commit must not be looked up");
  },
};

const init = (
  root: string,
  options: Parameters<typeof exec>[1]["options"] = {},
  o: { cwd?: string; deps?: InitDeps } = {},
) =>
  exec((ctx) => runInit(ctx, o.deps ?? PIN), {
    command: "init",
    cwd: o.cwd ?? root,
    options,
  });

describe("decide", () => {
  const siteOf = (root: string): string => join(root, "docs-site");

  test("infers everything the catalog knows from the origin remote", () => {
    const root = makeRepo({ origin: "git@github.com:Avunu/erpnext_taskview.git" });
    const { config, notes } = decide({ siteDir: siteOf(root), repoRoot: root, env: envFor(root) });
    expect(config).toEqual({
      name: "ERPNext TaskView",
      tagline:
        "A project and task workspace for ERPNext, with timers and hour budgets for staff and a portal where customers follow and work on their projects.",
      slug: "erpnext_taskview",
      platform: "frappe",
      repo: "https://github.com/Avunu/erpnext_taskview",
      domain: "erpnext-taskview.avunu.net",
      license: "MIT",
    });
    expect(config.branch).toBeUndefined();
    expect(notes.join("\n")).toContain(
      "repo: https://github.com/Avunu/erpnext_taskview  (the origin remote)",
    );
    expect(notes.join("\n")).toContain("slug: erpnext_taskview  (the catalog entry for");
    expect(notes.join("\n")).toContain(
      "domain: erpnext-taskview.avunu.net  (the slug, with _ written as -)",
    );
    expect(notes).toHaveLength(7);
  });

  test("the platform of the catalog entry, and its license", () => {
    const root = makeRepo({ origin: "https://github.com/Avunu/cloudflare-email-relay.git" });
    const { config } = decide({ siteDir: siteOf(root), repoRoot: root, env: envFor(root) });
    expect(config).toMatchObject({
      slug: "cloudflare-email-relay",
      platform: "general",
      license: "MIT",
    });
  });

  test("a repository that is not in the catalog needs the name, the tagline and the license, and says which option", () => {
    const root = makeRepo({ origin: "https://github.com/Avunu/some-new-tool" });
    const base = { siteDir: siteOf(root), repoRoot: root, env: envFor(root) };
    expect(() => decide(base)).toThrow(/cannot infer the name .* pass --name/);
    expect(() => decide({ ...base, name: "Some New Tool" })).toThrow(
      /cannot infer the tagline .* pass --tagline/,
    );
    expect(() => decide({ ...base, name: "Some New Tool", tagline: "Does a thing." })).toThrow(
      /cannot infer the license .* pass --license/,
    );
    const { config, notes } = decide({
      ...base,
      name: "Some New Tool",
      tagline: "Does a thing.",
      license: "MIT",
    });
    expect(config).toEqual({
      name: "Some New Tool",
      tagline: "Does a thing.",
      slug: "some-new-tool",
      platform: "general",
      repo: "https://github.com/Avunu/some-new-tool",
      domain: "some-new-tool.avunu.net",
      license: "MIT",
    });
    expect(notes.join("\n")).toContain("is not in the avunu.net catalog yet");
    expect(notes.join("\n")).toContain(
      "platform: general  (the default: pass --platform to change it)",
    );
  });

  test("options win over inference; a slug with an underscore gives a domain with a hyphen", () => {
    const root = makeRepo({ origin: "https://github.com/Avunu/frappe-nix" });
    const { config, notes } = decide({
      siteDir: siteOf(root),
      repoRoot: root,
      env: envFor(root),
      name: "My Name",
      tagline: "Mine.",
      slug: "my_tool",
      platform: "odoo",
      license: "GPL-3.0-or-later",
      branch: "develop",
    });
    expect(config).toEqual({
      name: "My Name",
      tagline: "Mine.",
      slug: "my_tool",
      platform: "odoo",
      repo: "https://github.com/Avunu/frappe-nix",
      domain: "my-tool.avunu.net",
      license: "GPL-3.0-or-later",
      branch: "develop",
    });
    expect(notes.join("\n")).not.toContain("name:");
  });

  test("a repository with several catalog entries: the one named like the repository", () => {
    const root = makeRepo({ origin: "https://github.com/Avunu/avunu-odoo-addons" });
    const { config } = decide({ siteDir: siteOf(root), repoRoot: root, env: envFor(root) });
    expect(config.slug).toBe("avunu-odoo-addons");
    expect(config.platform).toBe("odoo");
  });

  test("several entries and none named like the repository: --slug is asked for", () => {
    const root = makeRepo({ origin: "https://github.com/Avunu/avunu-odoo-addons" });
    const without = readBundledCatalog().filter((p) => p.slug !== "avunu-odoo-addons");
    const others = without.filter((p) => p.repo === "https://github.com/Avunu/avunu-odoo-addons");
    expect(others.length).toBeGreaterThan(1);
    vi.mocked(readBundledCatalog).mockReturnValueOnce(without);
    expect(() => decide({ siteDir: siteOf(root), repoRoot: root, env: envFor(root) })).toThrow(
      `has ${others.length} catalog entries (${others.map((p) => p.slug).join(", ")}): pass --slug`,
    );
  });

  test("--slug picks one of the entries and takes its values", () => {
    const root = makeRepo({ origin: "https://github.com/Avunu/avunu-odoo-addons" });
    const { config } = decide({
      siteDir: siteOf(root),
      repoRoot: root,
      env: envFor(root),
      slug: "odoo-ai",
    });
    expect(config).toMatchObject({
      slug: "odoo-ai",
      domain: "odoo-ai.avunu.net",
      platform: "odoo",
    });
    expect(config.name).toBe(readBundledCatalog().find((p) => p.slug === "odoo-ai")?.title);
  });

  test("a slug spelled differently from a catalog key is an error", () => {
    const root = makeRepo({ origin: "https://github.com/Avunu/erpnext_taskview" });
    expect(() =>
      decide({
        siteDir: siteOf(root),
        repoRoot: root,
        env: envFor(root),
        slug: "erpnext-taskview",
      }),
    ).toThrow(/erpnext_taskview/);
    // the other spelling is the key
    expect(
      decide({ siteDir: siteOf(root), repoRoot: root, env: envFor(root), slug: "erpnext_taskview" })
        .config.slug,
    ).toBe("erpnext_taskview");
  });

  test("an existing configuration wins over inference, so running init again never resets a tagline", () => {
    const root = makeRepo({
      origin: "https://github.com/Avunu/erpnext_taskview",
      files: {
        "docs-site/docusystem.config.json": JSON.stringify({
          name: "Mine",
          tagline: "Hand written.",
          slug: "erpnext_taskview",
          platform: "general",
          repo: "https://github.com/Avunu/erpnext_taskview",
          domain: "tasks.example.org",
          license: "Apache-2.0",
          branch: "develop",
          docs: "../documentation",
          images: "off",
          theme: { light: { "--color-action": "#4B2A99" } },
          jx: { $head: [] },
        }),
      },
    });
    const { config, notes } = decide({ siteDir: siteOf(root), repoRoot: root, env: envFor(root) });
    expect(config).toEqual({
      name: "Mine",
      tagline: "Hand written.",
      slug: "erpnext_taskview",
      platform: "general",
      repo: "https://github.com/Avunu/erpnext_taskview",
      domain: "tasks.example.org",
      license: "Apache-2.0",
      branch: "develop",
      docs: "../documentation",
      images: "off",
      theme: { light: { "--color-action": "#4B2A99" } },
      jx: { $head: [] },
    });
    expect(notes).toEqual([]);
  });

  test("an option wins over the existing configuration, and a new slug means a new domain", () => {
    const root = makeRepo({
      files: {
        "docs-site/docusystem.config.json": JSON.stringify({
          name: "Old",
          tagline: "Old.",
          slug: "frappe-nix",
          platform: "nixos",
          repo: "https://github.com/Avunu/frappe-nix",
          domain: "frappe-nix.avunu.net",
          license: "MIT",
        }),
      },
    });
    const kept = decide({
      siteDir: siteOf(root),
      repoRoot: root,
      env: envFor(root),
      tagline: "New.",
    });
    expect(kept.config).toMatchObject({ tagline: "New.", domain: "frappe-nix.avunu.net" });
    const moved = decide({
      siteDir: siteOf(root),
      repoRoot: root,
      env: envFor(root),
      slug: "odoo-ai",
    });
    expect(moved.config).toMatchObject({
      slug: "odoo-ai",
      domain: "odoo-ai.avunu.net",
      name: "Old",
    });
  });

  test("a site folder that is not docs-site still points at the repository's docs/", () => {
    const root = makeRepo();
    const { config } = decide({
      siteDir: join(root, "tools", "docs-site"),
      repoRoot: root,
      env: envFor(root),
    });
    expect(config.docs).toBe("../../docs");
    expect(
      decide({ siteDir: siteOf(root), repoRoot: root, env: envFor(root) }).config.docs,
    ).toBeUndefined();
    expect(
      decide({ siteDir: siteOf(root), repoRoot: root, env: envFor(root), docs: "../documentation" })
        .config.docs,
    ).toBe("../documentation");
    // the default written out is the default
    expect(
      decide({ siteDir: siteOf(root), repoRoot: root, env: envFor(root), docs: "../docs" }).config
        .docs,
    ).toBeUndefined();
  });

  test("what cannot be decided is an error that names the option", () => {
    const base = (root: string) => ({
      siteDir: join(root, "docs-site"),
      repoRoot: root,
      env: envFor(root),
    });
    const none = makeRepo({ origin: null });
    expect(() => decide(base(none))).toThrow(/no `origin` remote.*--repo/);
    expect(decide({ ...base(none), repo: "https://github.com/Avunu/frappe-nix" }).config.slug).toBe(
      "frappe-nix",
    );
    const elsewhere = makeRepo({ origin: "https://gitlab.com/Avunu/frappe-nix" });
    expect(() => decide(base(elsewhere))).toThrow(/not a GitHub repository: pass --repo/);
    expect(() => decide({ ...base(elsewhere), repo: "gitlab.com/x/y" })).toThrow(
      /--repo must be a GitHub repository/,
    );
    const ok = makeRepo();
    expect(() => decide({ ...base(ok), platform: "windows" })).toThrow(
      /--platform must be one of frappe, odoo, wordpress, nixos, general/,
    );
    expect(() => decide({ ...base(ok), domain: "Not A Domain" })).toThrow(
      /the values are not valid/,
    );
  });

  test("an existing configuration that is not JSON is reported, not overwritten", () => {
    const root = makeRepo({ files: { "docs-site/docusystem.config.json": "{ nope" } });
    expect(() => decide({ siteDir: siteOf(root), repoRoot: root, env: envFor(root) })).toThrow(
      /docusystem.config.json is not valid JSON/,
    );
  });
});

describe("init: where it runs", () => {
  test("at the repository root it writes the shell, and the files are the example shell's", async () => {
    const root = makeRepo();
    const { code, out, err } = await init(root);
    expect(err).toBe("");
    expect(code).toBe(0);
    for (const file of SHELL_FILES) expect(existsSync(join(root, file)), file).toBe(true);
    expect(readIn(root, "docs-site/docusystem.config.json")).toBe(
      readFixture("example-shell", "docs-site", "docusystem.config.json"),
    );
    expect(readIn(root, "docs-site/package.json")).toBe(
      readFixture("example-shell", "docs-site", "package.json"),
    );
    expect(readIn(root, "docs-site/.gitignore")).toBe(
      readFixture("example-shell", "docs-site", ".gitignore"),
    );
    expect(readIn(root, ".github/workflows/docs.yml")).toBe(
      readFixture("example-shell", ".github", "workflows", "docs.yml"),
    );
    expect(readIn(root, ".github/workflows/docs-publish.yml")).toBe(
      readFixture("example-shell", ".github", "workflows", "docs-publish.yml"),
    );
    expect(out).toContain("init: wrote 6 files");
    expect(out).toContain("Chosen for you (pass the option to change it):");
    expect(out).toContain("A maintainer still has to:");
    expect(out).toContain("CNAME frappe-nix -> avunu.github.io");
    // the domain is verified for the organization, and the end of the site is covered
    expect(out).toContain("Verify avunu.net once for the Avunu GitHub organization");
    expect(out).toContain("when the site is retired or its domain changes");
    expect(out.trimEnd().split("\n").at(-1)).toBe(
      "Next: cd docs-site && npm install && npm run check",
    );
    // no home page and no --from-readme: it says so
    expect(out).toContain(
      "docs/ has no README.md or index.md: write the documentation home page, or run init again with --from-readme",
    );
  });

  test("the example's dependabot.yml has both entries", async () => {
    const root = makeRepo();
    await init(root);
    const text = readIn(root, ".github/dependabot.yml") ?? "";
    expect(text.startsWith("version: 2\nupdates:\n  # The documentation site (docs-site/)")).toBe(
      true,
    );
    expect(text).toContain("  - package-ecosystem: npm\n    directory: /docs-site\n");
    expect(text).toContain("  - package-ecosystem: github-actions\n    directory: /\n");
  });

  test("run twice, it changes nothing the second time, and needs no network", async () => {
    const root = makeRepo();
    await init(root);
    const first = Object.fromEntries(SHELL_FILES.map((f) => [f, readIn(root, f)]));
    const again = await init(root, {}, { deps: NEVER });
    expect(again.code).toBe(0);
    expect(again.out).toContain("init: nothing to do: the shell is in place");
    expect(Object.fromEntries(SHELL_FILES.map((f) => [f, readIn(root, f)]))).toEqual(first);
  });

  test("a second run after the pins moved to another release leaves the callers alone", async () => {
    const root = makeRepo();
    await init(root);
    const docs = readIn(root, ".github/workflows/docs.yml") ?? "";
    writeFileSync(
      join(root, ".github/workflows/docs.yml"),
      docs.replaceAll(SHA, SHA2).replaceAll("v0.1.0", "v0.1.7"),
    );
    const { code, out } = await init(root, {}, { deps: NEVER });
    expect(code).toBe(0);
    expect(out).toContain("nothing to do");
    expect(readIn(root, ".github/workflows/docs.yml")).toContain(`@${SHA2} # v0.1.7`);
  });

  test("inside the site folder it produces docs-site once, never docs-site/docs-site", async () => {
    const root = makeRepo({ files: { "docs-site/keep.txt": "x" } });
    const { code, out } = await init(root, {}, { cwd: join(root, "docs-site") });
    expect(code).toBe(0);
    expect(existsSync(join(root, "docs-site", "docs-site"))).toBe(false);
    for (const file of SHELL_FILES) expect(existsSync(join(root, file)), file).toBe(true);
    expect(out.trimEnd().split("\n").at(-1)).toBe(
      "Next: cd docs-site && npm install && npm run check",
    );
    // and the same files as from the root
    const fromRoot = makeRepo();
    await init(fromRoot);
    for (const file of SHELL_FILES) expect(readIn(root, file), file).toBe(readIn(fromRoot, file));
  });

  test("from any other folder it refuses, says where to run it, and writes nothing", async () => {
    const root = makeRepo({ files: { "docs/README.md": "# x\n", "src/deep/file.ts": "" } });
    const before = listTree(root);
    for (const cwd of [join(root, "docs"), join(root, "src", "deep")]) {
      const { code, err } = await init(root, {}, { cwd });
      expect(code).toBe(1);
      expect(err).toContain("run it at the repository root");
      expect(err).toContain(join(root, "docs-site"));
    }
    expect(listTree(root)).toEqual(before);
  });

  test("outside a git repository it refuses", async () => {
    const dir = tempDir();
    const { code, err } = await exec((ctx) => runInit(ctx, PIN), {
      command: "init",
      cwd: dir,
      options: {},
    });
    expect(code).toBe(1);
    expect(err).toContain("not inside a git repository");
  });

  test("--site-dir puts the site elsewhere, and the workflows, the config and Dependabot follow", async () => {
    const root = makeRepo();
    const { code } = await init(root, { siteDir: "tools/docs-site" });
    expect(code).toBe(0);
    expect(existsSync(join(root, "tools/docs-site/docusystem.config.json"))).toBe(true);
    expect(existsSync(join(root, "docs-site"))).toBe(false);
    const config = JSON.parse(
      readIn(root, "tools/docs-site/docusystem.config.json") ?? "{}",
    ) as Record<string, unknown>;
    expect(config.docs).toBe("../../docs");
    expect(readIn(root, ".github/workflows/docs.yml")).toContain("site-directory: tools/docs-site");
    expect(readIn(root, ".github/workflows/docs.yml")).toContain('"tools/docs-site/**"');
    expect(readIn(root, ".github/dependabot.yml")).toContain("directory: /tools/docs-site");
    // inside it, without the option, init finds that it is in a site folder
    const again = await init(root, {}, { cwd: join(root, "tools/docs-site"), deps: NEVER });
    expect(again.out).toContain("nothing to do");
  });

  test("--site-dir that the workflow could not accept is refused", async () => {
    const root = makeRepo();
    for (const siteDir of ["../outside", "/abs/path", "a b", ".", ""]) {
      const { code, err } = await init(root, { siteDir });
      expect(code, siteDir).toBe(1);
      expect(err, siteDir).toContain("init:");
    }
    expect(existsSync(join(root, ".github"))).toBe(false);
  });

  test("a docs folder outside the repository is refused", async () => {
    const root = makeRepo();
    const { code, err } = await init(root, { docs: "../../outside" });
    expect(code).toBe(1);
    expect(err).toContain("outside the repository");
    expect(worktree(root)).toEqual([]);
  });

  test("--docs reaches the config and the path filters", async () => {
    const root = makeRepo();
    expect((await init(root, { docs: "../documentation" })).code).toBe(0);
    expect(readIn(root, "docs-site/docusystem.config.json")).toContain(
      '"docs": "../documentation"',
    );
    expect(readIn(root, ".github/workflows/docs.yml")).toContain(
      'paths: ["documentation/**", "docs-site/**"',
    );
  });

  test("an unknown repository stops before anything is written", async () => {
    const root = makeRepo({ origin: "https://github.com/Avunu/some-new-tool" });
    const { code, err } = await init(root);
    expect(code).toBe(1);
    expect(err).toContain("cannot infer the name");
    expect(err).toContain("--name");
    expect(worktree(root)).toEqual([]);
  });
});

describe("init: the release commit", () => {
  test("is the pin of both callers, with the version of the installed package as the comment", async () => {
    const root = makeRepo();
    await init(root);
    for (const file of ["docs.yml", "docs-publish.yml"]) {
      const text = readIn(root, `.github/workflows/${file}`) ?? "";
      for (const line of text.split("\n").filter((l) => l.includes("uses:"))) {
        expect(line).toMatch(/@0123456789abcdef0123456789abcdef01234567 # v0\.1\.0$/);
      }
    }
  });

  test("a commit that cannot be found stops everything, names --workflow-sha and writes nothing", async () => {
    const root = makeRepo();
    const { code, err } = await init(root, {}, { deps: OFFLINE });
    expect(code).toBe(1);
    expect(err).toContain("could not find the commit of the tag v0.1.0");
    expect(err).toContain("offline");
    expect(err).toContain("--workflow-sha");
    expect(err).toContain("Nothing was written");
    expect(worktree(root)).toEqual([]);
  });

  test("--workflow-sha needs no lookup; an upper-case id is lowered; a short one is refused", async () => {
    const root = makeRepo();
    expect((await init(root, { workflowSha: SHA2.toUpperCase() }, { deps: NEVER })).code).toBe(0);
    expect(readIn(root, ".github/workflows/docs.yml")).toContain(`@${SHA2} # v0.1.0`);
    const other = makeRepo();
    const bad = await init(other, { workflowSha: "0123456" }, { deps: NEVER });
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("--workflow-sha must be a full 40-character commit id");
    expect(worktree(other)).toEqual([]);
  });

  test("--no-workflow writes no caller, needs no commit, and adds no github-actions entry", async () => {
    const root = makeRepo();
    const { code } = await init(root, { noWorkflow: true }, { deps: NEVER });
    expect(code).toBe(0);
    expect(existsSync(join(root, ".github/workflows"))).toBe(false);
    const dependabot = readIn(root, ".github/dependabot.yml") ?? "";
    expect(dependabot).toContain("package-ecosystem: npm");
    expect(dependabot).not.toContain("github-actions");
  });
});

describe("init: what it refuses to overwrite", () => {
  const starter = readFixture("starter-docs.yml");

  test("a copy of the starter's 121-line workflow: refused, nothing at all is written", async () => {
    const root = makeRepo({ files: { ".github/workflows/docs.yml": starter } });
    const before = listTree(root);
    const { code, err } = await init(root);
    expect(code).toBe(1);
    expect(err).toContain("refused");
    expect(err).toContain(
      ".github/workflows/docs.yml exists and is not the caller that init writes",
    );
    expect(err).toContain("--force");
    expect(err).toContain("nothing was written");
    expect(listTree(root)).toEqual(before);
    expect(readIn(root, ".github/workflows/docs.yml")).toBe(starter);
  });

  test("--force replaces it with the caller", async () => {
    const root = makeRepo({ files: { ".github/workflows/docs.yml": starter } });
    const { code } = await init(root, { force: true });
    expect(code).toBe(0);
    expect(readIn(root, ".github/workflows/docs.yml")).toBe(
      readFixture("example-shell", ".github", "workflows", "docs.yml"),
    );
  });

  test("--no-workflow leaves a workflow that differs alone", async () => {
    const root = makeRepo({ files: { ".github/workflows/docs.yml": starter } });
    expect((await init(root, { noWorkflow: true })).code).toBe(0);
    expect(readIn(root, ".github/workflows/docs.yml")).toBe(starter);
  });

  test("a caller that someone edited is not overwritten either", async () => {
    const root = makeRepo();
    await init(root);
    const file = join(root, ".github/workflows/docs-publish.yml");
    const edited = `${readFileSync(file, "utf8")}\n# a note\n`;
    writeFileSync(file, edited);
    const { code, err } = await init(root);
    expect(code).toBe(1);
    expect(err).toContain("docs-publish.yml exists and is not the caller");
    expect(readFileSync(file, "utf8")).toBe(edited);
  });

  test("a path that is a symbolic link is never written through: refused before anything is written", async () => {
    const root = makeRepo();
    const elsewhere = tempDir();
    symlinkSync(elsewhere, join(root, ".github"));
    const { code, err } = await init(root);
    expect(code).toBe(1);
    expect(err).toContain(
      "refusing to write .github/workflows/docs.yml: .github is a symbolic link",
    );
    expect(err).toContain("Nothing was written");
    expect(existsSync(join(root, "docs-site"))).toBe(false);
    expect(listTree(elsewhere)).toEqual([]);
    // a link in the site folder too
    const other = makeRepo();
    mkdirSync(join(other, "docs-site"));
    writeFileSync(join(elsewhere, "pkg.json"), "{}\n");
    symlinkSync(join(elsewhere, "pkg.json"), join(other, "docs-site/package.json"));
    expect((await init(other)).code).toBe(1);
    expect(readFileSync(join(elsewhere, "pkg.json"), "utf8")).toBe("{}\n");
  });

  test("a configuration with a key that init does not know: refused, or dropped with --force", async () => {
    const config = JSON.parse(
      readFixture("example-shell", "docs-site", "docusystem.config.json"),
    ) as Record<string, unknown>;
    const root = makeRepo({
      files: { "docs-site/docusystem.config.json": JSON.stringify({ ...config, tagLine: "typo" }) },
    });
    const refused = await init(root);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("keys that init does not know (tagLine)");
    expect(existsSync(join(root, ".github"))).toBe(false);
    const forced = await init(root, { force: true });
    expect(forced.code).toBe(0);
    expect(readIn(root, "docs-site/docusystem.config.json")).not.toContain("tagLine");
  });
});

describe("init: package.json", () => {
  const withPackage = (pkg: unknown, indent: string | number = 2) =>
    makeRepo({
      files: {
        "docs-site/package.json": `${typeof pkg === "string" ? pkg : JSON.stringify(pkg, null, indent)}\n`,
      },
    });
  const packageOf = (root: string): Record<string, unknown> =>
    JSON.parse(readIn(root, "docs-site/package.json") ?? "{}") as Record<string, unknown>;

  test("a new one has the name of the slug, one dependency and the three scripts", async () => {
    const root = makeRepo({ origin: "https://github.com/Avunu/erpnext_taskview" });
    await init(root);
    expect(packageOf(root)).toEqual({
      name: "erpnext-taskview-docs",
      private: true,
      type: "module",
      scripts: { dev: "docusystem dev", build: "docusystem build", check: "docusystem check" },
      dependencies: { "@avunu/docusystem": "^0.1.0" },
    });
  });

  test("an existing one only gets the dependency and the scripts it lacks, in its own indentation", async () => {
    const root = withPackage(
      {
        name: "mine",
        license: "MIT",
        scripts: { test: "x", build: "my-build" },
        dependencies: { left: "^1.0.0" },
      },
      "\t",
    );
    const { code, out } = await init(root);
    expect(code).toBe(0);
    expect(packageOf(root)).toEqual({
      name: "mine",
      license: "MIT",
      scripts: { test: "x", build: "my-build", dev: "docusystem dev", check: "docusystem check" },
      dependencies: { left: "^1.0.0", "@avunu/docusystem": "^0.1.0" },
    });
    expect(readIn(root, "docs-site/package.json")).toContain('\n\t"name": "mine"');
    expect(out).toContain('kept your "build" script (the shell\'s is "docusystem build")');
  });

  test("one that has the dependency and the scripts already is not touched, byte for byte", async () => {
    const text =
      '{"name":"x","scripts":{"dev":"docusystem dev","build":"docusystem build","check":"docusystem check"},"devDependencies":{"@avunu/docusystem":"^0.0.5"}}';
    const root = withPackage(text);
    await init(root);
    expect(readIn(root, "docs-site/package.json")).toBe(`${text}\n`);
  });

  test("a copy of the starter (a postinstall script, a Jx dependency) is refused without --force", async () => {
    const starter = {
      name: "frappe-nix-docs",
      private: true,
      license: "MIT",
      scripts: {
        postinstall: "bun scripts/postinstall.ts",
        build: "bun scripts/build.ts",
        test: "bun test scripts",
      },
      dependencies: { "@jxsuite/compiler": "^5.0.0", "@jxsuite/parser": "^2.0.0" },
      devDependencies: { "@jxsuite/server": "^4.4.3", "@types/bun": "^1.0.0" },
    };
    const root = withPackage(starter);
    const refused = await init(root);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain(
      "a postinstall script and a dependency on @jxsuite/compiler, @jxsuite/parser, @jxsuite/server",
    );
    expect(refused.err).toContain("copy of the starter");
    expect(existsSync(join(root, ".github"))).toBe(false);

    const forced = await init(root, { force: true });
    expect(forced.code).toBe(0);
    expect(packageOf(root)).toEqual({
      name: "frappe-nix-docs",
      private: true,
      license: "MIT",
      scripts: { dev: "docusystem dev", build: "docusystem build", check: "docusystem check" },
      dependencies: { "@avunu/docusystem": "^0.1.0" },
      devDependencies: { "@types/bun": "^1.0.0" },
    });
  });

  test("a Jx dependency alone is enough to be refused", async () => {
    const root = withPackage({ name: "x", devDependencies: { "@jxsuite/runtime": "^4.0.0" } });
    expect((await init(root)).code).toBe(1);
  });

  test("--force does not rewrite a package.json that is not the starter's", async () => {
    const root = withPackage({
      name: "mine",
      scripts: { test: "x" },
      dependencies: { left: "^1.0.0" },
    });
    await init(root, { force: true });
    expect(packageOf(root)).toMatchObject({
      scripts: { test: "x", dev: "docusystem dev" },
      dependencies: { left: "^1.0.0" },
    });
  });

  test("a package.json that is not JSON is refused", async () => {
    const root = withPackage("{ not json");
    const { code, err } = await init(root);
    expect(code).toBe(1);
    expect(err).toContain("docs-site/package.json is not valid JSON");
  });
});

describe("init: .gitignore", () => {
  test("only the missing lines are appended, whatever spelling the others have", async () => {
    const root = makeRepo({
      files: { "docs-site/.gitignore": "# mine\n/node_modules\ndist\n.generated/" },
    });
    await init(root);
    expect(readIn(root, "docs-site/.gitignore")).toBe(
      "# mine\n/node_modules\ndist\n.generated/\n.docusystem/\n",
    );
  });

  test("one that has all three is left as it is", async () => {
    const text = "node_modules/\ndist/\n.docusystem/\nextra\n";
    const root = makeRepo({ files: { "docs-site/.gitignore": text } });
    await init(root);
    expect(readIn(root, "docs-site/.gitignore")).toBe(text);
  });
});

describe("init: --from-readme", () => {
  test("copies the repository's README when docs/ has no home page", async () => {
    const root = makeRepo({ files: { "README.md": "# Project\n\nText.\n" } });
    const { code, out } = await init(root, { fromReadme: true });
    expect(code).toBe(0);
    expect(readIn(root, "docs/README.md")).toBe("# Project\n\nText.\n");
    expect(readIn(root, "README.md")).toBe("# Project\n\nText.\n"); // never moved
    expect(out).toContain("docs/README.md  (a copy of README.md)");
    expect(out).not.toContain("--from-readme");
  });

  test("never overwrites a home page, whatever its case", async () => {
    for (const home of ["README.md", "readme.md", "Readme.md", "index.md", "INDEX.md"]) {
      const root = makeRepo({ files: { "README.md": "root\n", [`docs/${home}`]: "mine\n" } });
      await init(root, { fromReadme: true });
      expect(readIn(root, `docs/${home}`), home).toBe("mine\n");
      expect(listTree(join(root, "docs")), home).toEqual([home]);
    }
  });

  test("a README with another case is found, and a repository without one is told so", async () => {
    const root = makeRepo({ files: { "readme.md": "lower\n" } });
    await init(root, { fromReadme: true });
    expect(readIn(root, "docs/README.md")).toBe("lower\n");
    const bare = makeRepo();
    const { code, out } = await init(bare, { fromReadme: true });
    expect(code).toBe(0);
    expect(out).toContain("the repository has no README to copy");
    expect(existsSync(join(bare, "docs"))).toBe(false);
  });

  test("an existing docs/ without a home page gets the README in it", async () => {
    const root = makeRepo({ files: { "README.md": "root\n", "docs/guide.md": "g\n" } });
    await init(root, { fromReadme: true });
    expect(listTree(join(root, "docs"))).toEqual(["README.md", "guide.md"]);
  });
});

describe("init: --dry-run", () => {
  test("writes nothing and prints every file and its diff", async () => {
    const root = makeRepo({
      files: {
        ".github/dependabot.yml":
          "version: 2\nupdates:\n  - package-ecosystem: pip\n    directory: /\n",
      },
    });
    const before = listTree(root);
    const { code, out } = await init(root, { dryRun: true });
    expect(code).toBe(0);
    expect(listTree(root)).toEqual(before);
    expect(out).toContain("init (dry run): would write 6 files; nothing was written");
    for (const file of SHELL_FILES) expect(out).toContain(file);
    expect(out).toContain("--- /dev/null\n+++ b/docs-site/docusystem.config.json\n@@ -0,0 +1,");
    expect(out).toContain("--- a/.github/dependabot.yml\n+++ b/.github/dependabot.yml");
    expect(out).toContain("+  - package-ecosystem: npm");
    expect(out).toContain("would create");
    expect(out).toContain("would update");
  });

  test("a dry run that would fail fails too", async () => {
    const root = makeRepo({
      files: { ".github/workflows/docs.yml": readFixture("starter-docs.yml") },
    });
    expect((await init(root, { dryRun: true })).code).toBe(1);
  });
});

describe("init: Dependabot and the auto-merge workflow", () => {
  test("appends to the repository's dependabot.yml without replacing it", async () => {
    const original =
      "# mine\nversion: 2\nupdates:\n  - package-ecosystem: github-actions\n    directory: /\n    schedule:\n      interval: daily\n";
    const root = makeRepo({ files: { ".github/dependabot.yml": original } });
    await init(root);
    const text = readIn(root, ".github/dependabot.yml") ?? "";
    expect(text.startsWith(original)).toBe(true);
    expect(text).toContain("package-ecosystem: npm");
    expect(text.match(/package-ecosystem: github-actions/g)).toHaveLength(1);
  });

  test("a file it cannot edit safely is left alone, the snippet is printed, the rest is written", async () => {
    const root = makeRepo({ files: { ".github/dependabot.yml": "version: 2\nupdates: yes\n" } });
    const { code, out } = await init(root);
    expect(code).toBe(0);
    expect(readIn(root, ".github/dependabot.yml")).toBe("version: 2\nupdates: yes\n");
    expect(out).toContain("Not done, for you to do by hand:");
    expect(out).toContain(
      "has an `updates` that is not a list; add this to its `updates:` list by hand:",
    );
    expect(out).toContain("package-ecosystem: npm");
    expect(existsSync(join(root, "docs-site/docusystem.config.json"))).toBe(true);
  });

  test("a repository with dependabot.yaml gets its entries there, not in a second file", async () => {
    const original = "version: 2\nupdates:\n  - package-ecosystem: pip\n    directory: /\n";
    const root = makeRepo({ files: { ".github/dependabot.yaml": original } });
    await init(root);
    expect(existsSync(join(root, ".github/dependabot.yml"))).toBe(false);
    const text = readIn(root, ".github/dependabot.yaml") ?? "";
    expect(text.startsWith(original)).toBe(true);
    expect(text).toContain("package-ecosystem: npm");
    // and a second run finds the entries there
    expect((await init(root, {}, { deps: NEVER })).out).toContain("nothing to do");
  });

  test("--no-dependabot", async () => {
    const root = makeRepo();
    await init(root, { noDependabot: true });
    expect(existsSync(join(root, ".github/dependabot.yml"))).toBe(false);
    expect(existsSync(join(root, ".github/workflows/docs.yml"))).toBe(true);
  });

  const automerge = `name: Dependabot auto-merge
on: pull_request
jobs:
  auto-merge:
    runs-on: ubuntu-latest
    if: \${{ github.actor == 'dependabot[bot]' }}
    steps:
      - run: gh pr merge --auto --squash "$PR_URL"
`;

  test("the standard auto-merge condition gets the site's exclusion", async () => {
    const root = makeRepo({ files: { ".github/workflows/dependabot-auto-merge.yml": automerge } });
    const { out } = await init(root);
    const text = readIn(root, ".github/workflows/dependabot-auto-merge.yml") ?? "";
    expect(text).toContain(
      "&& !startsWith(github.head_ref, 'dependabot/npm_and_yarn/docs-site') }}",
    );
    expect(text).toContain(
      "# The documentation site's package updates (docs-site/) are reviewed by a person",
    );
    expect(out).toContain("docs-site updates now wait for a person");
  });

  test("the pull request author's condition, the form zizmor recommends, gets the exclusion too", async () => {
    const author = automerge.replace(
      "github.actor == 'dependabot[bot]'",
      "github.event.pull_request.user.login == 'dependabot[bot]'",
    );
    const root = makeRepo({ files: { ".github/workflows/dependabot-auto-merge.yml": author } });
    const { code, out } = await init(root);
    expect(code).toBe(0);
    expect(readIn(root, ".github/workflows/dependabot-auto-merge.yml")).toContain(
      "if: ${{ github.event.pull_request.user.login == 'dependabot[bot]' && !startsWith(github.head_ref, 'dependabot/npm_and_yarn/docs-site') }}",
    );
    expect(out).toContain("docs-site updates now wait for a person");
    expect(out).not.toContain("dependabot-auto-merge.yml:"); // nothing left to do by hand for it
  });

  test("a folded multi-line condition gets the exclusion as a new first line", async () => {
    const folded = automerge.replace(
      "if: ${{ github.actor == 'dependabot[bot]' }}",
      [
        "if: >-",
        "      github.event.pull_request.user.login == 'dependabot[bot]' &&",
        "      github.repository == 'Avunu/frappe-nix'",
      ].join("\n"),
    );
    const root = makeRepo({ files: { ".github/workflows/dependabot-auto-merge.yml": folded } });
    const { code, out } = await init(root);
    expect(code).toBe(0);
    const text = readIn(root, ".github/workflows/dependabot-auto-merge.yml") ?? "";
    expect(text).toContain(
      [
        "    if: >-",
        "      !startsWith(github.head_ref, 'dependabot/npm_and_yarn/docs-site') &&",
        "      github.event.pull_request.user.login == 'dependabot[bot]' &&",
        "      github.repository == 'Avunu/frappe-nix'",
      ].join("\n"),
    );
    expect(out).not.toContain("dependabot-auto-merge.yml:"); // nothing left to do by hand for it
  });

  test("a shape it cannot patch is left alone, and the condition and the finished line are printed", async () => {
    const odd = automerge.replace(
      "if: ${{ github.actor == 'dependabot[bot]' }}",
      `if: "github.actor == 'dependabot[bot]' && always()"`,
    );
    const root = makeRepo({ files: { ".github/workflows/dependabot-auto-merge.yml": odd } });
    const { code, out } = await init(root);
    expect(code).toBe(0);
    expect(readIn(root, ".github/workflows/dependabot-auto-merge.yml")).toBe(odd);
    expect(out).toContain("Not done, for you to do by hand:");
    expect(out).toContain("line 6: `github.actor == 'dependabot[bot]' && always()`");
    expect(out).toContain(
      "`if: ${{ github.actor == 'dependabot[bot]' && always() && !startsWith(github.head_ref, 'dependabot/npm_and_yarn/docs-site') }}`",
    );
  });

  test("--no-patch-automerge", async () => {
    const root = makeRepo({ files: { ".github/workflows/dependabot-auto-merge.yml": automerge } });
    await init(root, { noPatchAutomerge: true });
    expect(readIn(root, ".github/workflows/dependabot-auto-merge.yml")).toBe(automerge);
  });
});

describe.each(PILOTS)("init in a copy of %s's .github", (pilot) => {
  test("converts the bun entry and exclusion by one line each, and refuses the starter's workflow until --force", async () => {
    const root = makeRepo({
      origin: `https://github.com/Avunu/${pilot}.git`,
      files: { ".github/workflows/docs.yml": readFixture("starter-docs.yml") },
    });
    copyPilotGithub(root, pilot);
    const dependabot = readIn(root, ".github/dependabot.yml") ?? "";
    const merge = readIn(root, ".github/workflows/dependabot-auto-merge.yml") ?? "";

    expect((await init(root)).code).toBe(1);
    expect(readIn(root, ".github/dependabot.yml")).toBe(dependabot);

    const { code, out } = await init(root, { force: true });
    expect(code).toBe(0);
    const diff = (before: string, after: string): string[][] => {
      const b = before.split("\n");
      return after.split("\n").flatMap((line, i) => (line === b[i] ? [] : [[b[i] ?? "", line]]));
    };
    const changedDependabot = readIn(root, ".github/dependabot.yml") ?? "";
    expect(changedDependabot.split("\n")).toHaveLength(dependabot.split("\n").length);
    expect(diff(dependabot, changedDependabot)).toEqual([
      ["  - package-ecosystem: bun", "  - package-ecosystem: npm"],
    ]);
    const changedMerge = readIn(root, ".github/workflows/dependabot-auto-merge.yml") ?? "";
    expect(diff(merge, changedMerge)).toHaveLength(1);
    expect(changedMerge).toContain("dependabot/npm_and_yarn/docs-site");
    expect(changedMerge).not.toContain("dependabot/bun/");
    expect(out).toContain("converted the bun entry for /docs-site to npm");
  });
});

describe("the command line", () => {
  test("docusystem init --dry-run reaches init with its options", async () => {
    const root = makeRepo();
    const result = await runCli(
      ["init", "--dry-run", "--workflow-sha", SHA, "--tagline", "Mine."],
      {
        cwd: root,
        env: envFor(root),
      },
    );
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("would write 6 files");
    expect(result.stdout).toContain('+  "tagline": "Mine.",');
    expect(worktree(root)).toEqual([]);
  });

  test("init takes --site-dir and not --site", async () => {
    const root = makeRepo();
    const result = await runCli(["init", "--site", "x"], { cwd: root, env: envFor(root) });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("init takes --site-dir");
  });
});

test("a repository that has docs/README.md needs no note about the home page", async () => {
  const root = makeRepo({ files: { "docs/README.md": "# Home\n" } });
  const { out } = await init(root);
  expect(out).not.toContain("write the documentation home page");
});
