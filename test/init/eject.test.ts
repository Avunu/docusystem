// `docusystem eject` (4.1, 6): which files, all or nothing, and the record. The copy itself is
// `ejectFile` of WP2 (the fake of ./support/neighbours.ts until it is merged); the files are the
// package's real `site/` (WP7).
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { ejectableFiles, runEject } from "../../src/commands/eject.js";
import { ejectFile } from "../../src/lib/overrides.js";
import { REPO_ROOT } from "../support/paths.js";
import { runCli } from "../support/index.js";
import { packageSiteForTests } from "./support/neighbours.js";
import { initialisedRepo } from "./support/initialised.js";
import { envFor, exec, makeRepo, readIn, worktree } from "./support/shell.js";

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

const SITE_ROOT = packageSiteForTests();
const sha = (text: Buffer | string): string => createHash("sha256").update(text).digest("hex");

const eject = (
  cwd: string,
  args: string[],
  options: Parameters<typeof exec>[1]["options"] = {},
  siteRoot: string = SITE_ROOT,
) => exec((ctx) => runEject(ctx, { siteRoot }), { command: "eject", cwd, args, options });

const FOOTER = "components/docs-footer.json";
const BASE = "layouts/base.json";

describe("ejectableFiles", () => {
  test("components, layouts and pages of the package, as paths, sorted", () => {
    const files = ejectableFiles(SITE_ROOT);
    expect(files).toContain(FOOTER);
    expect(files).toContain(BASE);
    expect(files).toContain("pages/index.json");
    expect(files).toEqual([...files].sort());
    expect(files.every((file) => /^(components|layouts|pages)\//.test(file))).toBe(true);
  });

  test("a package without those folders ships nothing to eject", () => {
    expect(ejectableFiles(join(REPO_ROOT, "test"))).toEqual([]);
  });
});

describe("eject", () => {
  test("copies a package file into overrides/ and records its version and sha256", async () => {
    const root = await initialisedRepo();
    const { code, out, err } = await eject(root, [FOOTER]);
    expect(err).toBe("");
    expect(code).toBe(0);
    const copy = join(root, "docs-site/overrides", ...FOOTER.split("/"));
    expect(readFileSync(copy)).toEqual(readFileSync(join(SITE_ROOT, ...FOOTER.split("/"))));
    const record = JSON.parse(readIn(root, "docs-site/overrides/.ejected.json") ?? "{}") as Record<
      string,
      { from: string; sha256: string }
    >;
    expect(Object.keys(record)).toEqual([FOOTER]);
    expect(record[FOOTER]?.sha256).toBe(sha(readFileSync(join(SITE_ROOT, ...FOOTER.split("/")))));
    expect(typeof record[FOOTER]?.from).toBe("string");
    expect(out).toContain(`eject: overrides/${FOOTER}`);
    expect(out).toContain("1 file copied into overrides/ and recorded in overrides/.ejected.json.");
    expect(out).toContain("no longer follow package updates");
  });

  test("several files, a leading ./ and a repeated name", async () => {
    const root = await initialisedRepo();
    const { code, out } = await eject(root, [`./${FOOTER}`, BASE, FOOTER]);
    expect(code).toBe(0);
    expect(out).toContain("2 files copied");
    expect(worktree(join(root, "docs-site/overrides"))).toEqual(
      [".ejected.json", "components/", `${FOOTER}`, "layouts/", `${BASE}`].sort(),
    );
  });

  test("--all copies every component, layout and page", async () => {
    const root = await initialisedRepo();
    const { code, out } = await eject(root, [], { all: true });
    expect(code).toBe(0);
    const files = ejectableFiles(SITE_ROOT);
    for (const file of files)
      expect(existsSync(join(root, "docs-site/overrides", ...file.split("/"))), file).toBe(true);
    const record = JSON.parse(readIn(root, "docs-site/overrides/.ejected.json") ?? "{}") as Record<
      string,
      unknown
    >;
    expect(Object.keys(record).sort()).toEqual(files);
    expect(out).toContain(`${files.length} files copied`);
  });

  test("works from the repository root and from inside the site folder, and with --site", async () => {
    const root = await initialisedRepo();
    expect((await eject(join(root, "docs-site"), [FOOTER])).code).toBe(0);
    const other = await initialisedRepo();
    expect(
      (await eject(join(other, "docs"), [FOOTER], { site: join(other, "docs-site") })).code,
    ).toBe(0);
    expect(existsSync(join(other, "docs-site/overrides", ...FOOTER.split("/")))).toBe(true);
  });
});

describe("what it refuses", () => {
  test("a file the package does not ship: exit 1, names it and what is shipped, copies nothing (not even the valid ones)", async () => {
    const root = await initialisedRepo();
    const before = worktree(root);
    const { code, err } = await eject(root, [FOOTER, "components/docs-foot.json"]);
    expect(code).toBe(1);
    expect(err).toContain('the package has no file "components/docs-foot.json" to eject');
    expect(err).toContain(`It ships: ${ejectableFiles(SITE_ROOT).join(", ")}`);
    expect(worktree(root)).toEqual(before);
  });

  test.each([
    "components",
    "components/",
    "../components/docs-footer.json",
    "components/../layouts/base.json",
    "/etc/passwd",
    "project.base.json",
    "public/favicon.svg",
    "data/projects.snapshot.json",
    "overrides/components/docs-footer.json",
    "components\\docs-footer.json",
  ])("%s is not a package file that can be ejected", async (arg) => {
    const root = await initialisedRepo();
    const { code } = await eject(root, [arg]);
    expect(code).toBe(1);
    expect(existsSync(join(root, "docs-site/overrides"))).toBe(false);
  });

  test("an override that exists already: exit 1, nothing is copied, --force replaces it", async () => {
    const root = await initialisedRepo();
    await eject(root, [FOOTER]);
    const copy = join(root, "docs-site/overrides", ...FOOTER.split("/"));
    writeFileSync(copy, "my change\n");
    const before = worktree(root);

    const refused = await eject(root, [FOOTER, BASE]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain(`an override exists already: overrides/${FOOTER}`);
    expect(refused.err).toContain("Nothing was copied");
    expect(refused.err).toContain("--force");
    expect(refused.err).toContain(
      "replace it with the package's file (your changes to it are lost)",
    );
    expect(readFileSync(copy, "utf8")).toBe("my change\n");
    expect(worktree(root)).toEqual(before);

    const forced = await eject(root, [FOOTER, BASE], { force: true });
    expect(forced.code).toBe(0);
    expect(readFileSync(copy)).toEqual(readFileSync(join(SITE_ROOT, ...FOOTER.split("/"))));
    expect(existsSync(join(root, "docs-site/overrides", ...BASE.split("/")))).toBe(true);
  });

  test("--all with overrides that exist is refused the same way, in the plural", async () => {
    const root = await initialisedRepo();
    await eject(root, [FOOTER, BASE]);
    const { code, err } = await eject(root, [], { all: true });
    expect(code).toBe(1);
    expect(err).toContain(`overrides exist already: overrides/${FOOTER}, overrides/${BASE}`);
    expect(err).toContain("replace them with the package's files (your changes to them are lost)");
    expect(existsSync(join(root, "docs-site/overrides/pages/index.json"))).toBe(false);
  });

  test("no files and no --all, or both, is a usage error (exit 2)", async () => {
    const root = await initialisedRepo();
    const none = await eject(root, []);
    expect(none.code).toBe(2);
    expect(none.err).toContain("name the files to eject");
    expect(none.err).toContain("Usage: docusystem eject");
    const both = await eject(root, [FOOTER], { all: true });
    expect(both.code).toBe(2);
    expect(both.err).toContain("give files, or --all, not both");
    expect(existsSync(join(root, "docs-site/overrides"))).toBe(false);
  });

  test("no site folder: exit 1 and where it looked", async () => {
    const root = makeRepo();
    const { code, err } = await eject(root, [FOOTER]);
    expect(code).toBe(1);
    expect(err).toContain("docusystem.config.json");
  });

  test("a package that ships nothing", async () => {
    const root = await initialisedRepo();
    const { code, err } = await eject(root, [], { all: true }, join(REPO_ROOT, "test"));
    expect(code).toBe(1);
    expect(err).toContain("ships no components, layouts or pages");
    const named = await eject(root, [FOOTER], {}, join(REPO_ROOT, "test"));
    expect(named.err).toContain("It ships no components, layouts or pages.");
  });

  test("a failure of the copy is reported with what was copied before it", async () => {
    const root = await initialisedRepo();
    vi.mocked(ejectFile).mockImplementationOnce((siteDir, rel, o) => {
      const real = join(siteDir, "overrides", ...rel.split("/"));
      void o;
      return { to: real };
    });
    vi.mocked(ejectFile).mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    const { code, err } = await eject(root, [FOOTER, BASE]);
    expect(code).toBe(1);
    expect(err).toContain("disk full");
    expect(err).toContain(`already copied: overrides/${FOOTER}`);
  });
});

describe("the command line", () => {
  const shipped = existsSync(join(REPO_ROOT, "site", "components", "docs-footer.json"));

  test.runIf(shipped)(
    "docusystem eject components/docs-footer.json, with the package's own site folder",
    async () => {
      const root = await initialisedRepo();
      const result = await runCli(["eject", "--site", join(root, "docs-site"), FOOTER], {
        cwd: root,
        env: envFor(root),
      });
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
      expect(existsSync(join(root, "docs-site/overrides", ...FOOTER.split("/")))).toBe(true);
    },
  );

  test("the usage error reaches the exit code", async () => {
    const root = await initialisedRepo();
    const result = await runCli(["eject", "--site", join(root, "docs-site")], {
      cwd: root,
      env: envFor(root),
    });
    expect(result.code).toBe(2);
  });
});
