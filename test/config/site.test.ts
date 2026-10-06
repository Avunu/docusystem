import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  CONFIG_FILE,
  ConfigError,
  findRepoRoot,
  findSiteDir,
  pathsFor,
  resolveBranch,
} from "../../src/lib/config.js";
import { at, escapeRegExp, git, initRepo, tempDir, writeTree } from "../support/index.js";
import { GOOD, shell } from "./helpers.js";

const CONFIG = JSON.stringify(GOOD);

describe("findSiteDir", () => {
  test("--site wins, resolved against the current folder", () => {
    const { repo, site } = shell();
    expect(findSiteDir("docs-site", repo)).toBe(site);
    expect(findSiteDir(site, tempDir())).toBe(site);
    expect(findSiteDir("../docs-site", join(repo, "docs"))).toBe(site);
  });

  test("--site wins over a configuration in the current folder", () => {
    const repo = tempDir();
    writeTree(repo, { [CONFIG_FILE]: CONFIG, "other/docusystem.config.json": CONFIG });
    expect(findSiteDir("other", repo)).toBe(join(repo, "other"));
  });

  test("the current folder, when it has the configuration", () => {
    const { site } = shell();
    expect(findSiteDir(undefined, site)).toBe(site);
  });

  test("else ./docs-site", () => {
    const { repo, site } = shell();
    expect(findSiteDir(undefined, repo)).toBe(site);
  });

  test("the current folder comes before ./docs-site", () => {
    const repo = tempDir();
    writeTree(repo, {
      [CONFIG_FILE]: CONFIG,
      [`docs-site/${CONFIG_FILE}`]: CONFIG,
    });
    expect(findSiteDir(undefined, repo)).toBe(repo);
  });

  test("nothing found: the message lists what was searched and what to do", () => {
    const repo = tempDir();
    try {
      findSiteDir(undefined, repo);
      expect.unreachable();
    } catch (error) {
      const { message } = error as Error;
      expect(message).toContain(`no ${CONFIG_FILE} found`);
      expect(message).toContain(repo);
      expect(message).toContain(join(repo, "docs-site"));
      expect(message).toContain("docusystem init");
      expect(message).toContain("--site");
    }
  });

  test("--site without a configuration says so, and points at ./docs-site when that is the site", () => {
    const { repo, site } = shell();
    expect(() => findSiteDir(".", repo)).toThrow(
      new RegExp(
        `there is no ${escapeRegExp(CONFIG_FILE)} in ${escapeRegExp(repo)}.*the site folder is ${escapeRegExp(site)}`,
      ),
    );
    expect(() => findSiteDir("docs", repo)).toThrow(/there is no docusystem\.config\.json in /);
  });

  test("--site that is not a folder", () => {
    const repo = tempDir();
    expect(() => findSiteDir("nowhere", repo)).toThrow(`${join(repo, "nowhere")} is not a folder`);
  });

  test("a folder named like the configuration is not one", () => {
    const repo = tempDir();
    mkdirSync(join(repo, CONFIG_FILE));
    expect(() => findSiteDir(undefined, repo)).toThrow(/no docusystem\.config\.json found/);
  });
});

describe("findRepoRoot", () => {
  test("the nearest ancestor with a .git folder", () => {
    const { repo, site } = shell();
    expect(findRepoRoot(site)).toBe(repo);
    mkdirSync(join(site, "deeper"));
    expect(findRepoRoot(join(site, "deeper"))).toBe(repo);
  });

  test("a .git file (a worktree or a submodule) counts", () => {
    const repo = tempDir();
    writeTree(repo, { ".git": "gitdir: /elsewhere/.git/worktrees/x\n", "docs-site/a": "" });
    expect(findRepoRoot(join(repo, "docs-site"))).toBe(repo);
  });

  test("the site folder itself, when it is the repository", () => {
    const repo = tempDir();
    writeTree(repo, { ".git/HEAD": "" });
    expect(findRepoRoot(repo)).toBe(repo);
  });

  test("the nearest one wins", () => {
    const outer = tempDir();
    writeTree(outer, { ".git/HEAD": "", "inner/.git/HEAD": "", "inner/site/a": "" });
    expect(findRepoRoot(join(outer, "inner", "site"))).toBe(join(outer, "inner"));
  });

  test("with no .git anywhere: the parent of the site folder", () => {
    const base = tempDir();
    const site = join(base, "work", "docs-site");
    mkdirSync(site, { recursive: true });
    expect(findRepoRoot(site)).toBe(join(base, "work"));
  });

  test("a relative site folder is resolved against the current folder", () => {
    const { repo, site } = shell();
    // The current folder is the one that holds the repository, as it would be for a person who is
    // there. The real one would do on Linux and macOS, but not on Windows: a path from one drive to
    // another cannot be relative, and the runner's temporary folder is not on the drive of the checkout.
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(dirname(repo));
    try {
      const relativeSite = relative(process.cwd(), site);
      expect(isAbsolute(relativeSite)).toBe(false);
      expect(findRepoRoot(relativeSite)).toBe(repo);
    } finally {
      cwd.mockRestore();
    }
  });
});

describe("resolveBranch", () => {
  const originHead = (dir: string, branch: string): void => {
    initRepo(dir, { origin: "https://github.com/Avunu/example.git" });
    git(dir, "symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${branch}`);
  };

  test("the configuration wins over everything", () => {
    const dir = tempDir();
    originHead(dir, "develop");
    expect(resolveBranch({ branch: "18.0" }, dir, { DOCUSYSTEM_BRANCH: "main" })).toBe("18.0");
  });

  test("then DOCUSYSTEM_BRANCH, over origin/HEAD", () => {
    const dir = tempDir();
    originHead(dir, "develop");
    expect(resolveBranch({}, dir, { DOCUSYSTEM_BRANCH: "18.0" })).toBe("18.0");
    expect(resolveBranch({}, dir, { DOCUSYSTEM_BRANCH: "release/1.2" })).toBe("release/1.2");
  });

  test("an invalid DOCUSYSTEM_BRANCH is ignored", () => {
    const dir = tempDir();
    originHead(dir, "develop");
    for (const bad of ["a b", "a..b", "-x", "", "x;y"]) {
      expect(resolveBranch({}, dir, { DOCUSYSTEM_BRANCH: bad }), bad).toBe("develop");
    }
  });

  test("then origin/HEAD, without the origin/", () => {
    const dir = tempDir();
    originHead(dir, "develop");
    expect(resolveBranch({}, dir, {})).toBe("develop");
    const other = tempDir();
    originHead(other, "release/18");
    expect(resolveBranch({}, other, {})).toBe("release/18");
  });

  test("then main", () => {
    const withoutHead = tempDir();
    initRepo(withoutHead, { origin: "https://github.com/Avunu/example.git" });
    expect(resolveBranch({}, withoutHead, {})).toBe("main");
    const notARepo = tempDir();
    expect(resolveBranch({}, notARepo, {})).toBe("main");
    expect(resolveBranch({}, join(notARepo, "does-not-exist"), {})).toBe("main");
  });

  test("a folder that is not a repository does not borrow the answer of one above it", () => {
    const outer = tempDir();
    originHead(outer, "develop");
    const inner = join(outer, "inner");
    mkdirSync(inner);
    expect(resolveBranch({}, inner, {})).toBe("main");
    expect(resolveBranch({}, outer, {})).toBe("develop");
  });

  test("an origin/HEAD that is not a valid branch name is not used", () => {
    const dir = tempDir();
    originHead(dir, "a;b");
    expect(resolveBranch({}, dir, {})).toBe("main");
  });

  test("the process environment is the default", () => {
    const dir = tempDir();
    const before = process.env.DOCUSYSTEM_BRANCH;
    try {
      process.env.DOCUSYSTEM_BRANCH = "from-process";
      expect(resolveBranch({}, dir)).toBe("from-process");
    } finally {
      if (before === undefined) delete process.env.DOCUSYSTEM_BRANCH;
      else process.env.DOCUSYSTEM_BRANCH = before;
    }
  });
});

describe("pathsFor", () => {
  test("every path of a run, for the usual layout", () => {
    const { repo, site } = shell();
    const work = join(site, ".docusystem");
    expect(pathsFor(site, {})).toEqual({
      siteDir: site,
      repoRoot: repo,
      docsDir: join(repo, "docs"),
      work,
      root: join(work, "site"),
      stagedDocs: join(work, "site", ".generated", "docs"),
      navFile: join(work, "site", ".generated", "nav.json"),
      jxDist: join(work, "site", "dist"),
      dist: join(site, "dist"),
      serve: join(work, "serve"),
      manifest: join(work, "manifest.json"),
      jxLog: join(work, "jx.log"),
      lock: join(work, "lock"),
    });
  });

  test("every path is absolute and the site folder may be given relative", () => {
    const { repo, site } = shell();
    const paths = pathsFor(relative(process.cwd(), site), {});
    for (const value of Object.values(paths)) expect(value).toBe(resolve(value));
    expect(paths.siteDir).toBe(site);
    expect(paths.repoRoot).toBe(repo);
  });

  test("docs is resolved against the site folder", () => {
    const { repo, site } = shell();
    expect(pathsFor(site, { docs: "../documentation" }).docsDir).toBe(join(repo, "documentation"));
    expect(pathsFor(site, { docs: "docs" }).docsDir).toBe(join(site, "docs"));
    expect(pathsFor(site, { docs: "../a/../docs" }).docsDir).toBe(join(repo, "docs"));
  });

  test("the repository root itself may be the Markdown folder", () => {
    const { repo, site } = shell();
    expect(pathsFor(site, { docs: ".." }).docsDir).toBe(repo);
  });

  test.each(["../../outside", "../..", "../../docs", "../docs/../../x"])(
    "docs %s is outside the repository and refused",
    (docs) => {
      const { site } = shell();
      expect(() => pathsFor(site, { docs })).toThrow(ConfigError);
      try {
        pathsFor(site, { docs });
      } catch (error) {
        const [problem] = (error as ConfigError).problems;
        expect(problem).toContain("outside the repository");
        expect(problem).toContain("never published");
        expect(problem).toContain(JSON.stringify(docs));
      }
    },
  );

  test("an absolute docs outside the repository is refused too", () => {
    const { site } = shell();
    expect(() => pathsFor(site, { docs: tempDir() })).toThrow(/outside the repository/);
  });

  test("docs inside what docusystem generates is refused", () => {
    const { site } = shell();
    expect(() => pathsFor(site, { docs: ".docusystem/site" })).toThrow(
      /inside a folder that docusystem generates/,
    );
    expect(() => pathsFor(site, { docs: "dist" })).toThrow(
      /inside a folder that docusystem generates/,
    );
    expect(() => pathsFor(site, { docs: "./dist/x" })).toThrow(/generates/);
  });

  test("a docs folder that is a link out of the repository is refused; one that stays inside is fine", () => {
    const { repo, site } = shell();
    const outside = tempDir();
    writeFileSync(join(outside, "README.md"), "# x\n");
    symlinkSync(outside, join(repo, "linked-out"));
    symlinkSync(join(repo, "docs"), join(repo, "linked-in"));
    expect(() => pathsFor(site, { docs: "../linked-out" })).toThrow(
      /a link to .*outside the repository/,
    );
    expect(pathsFor(site, { docs: "../linked-in" }).docsDir).toBe(join(repo, "linked-in"));
  });

  test("a docs folder that does not exist yet is computed (preflight reports it)", () => {
    const { repo, site } = shell();
    expect(pathsFor(site, { docs: "../not-yet" }).docsDir).toBe(join(repo, "not-yet"));
  });

  test("with no .git, the repository is the parent of the site folder", () => {
    const base = tempDir();
    const site = join(base, "r", "docs-site");
    mkdirSync(site, { recursive: true });
    const paths = pathsFor(site, {});
    expect(paths.repoRoot).toBe(join(base, "r"));
    expect(paths.docsDir).toBe(join(base, "r", "docs"));
    expect(() => pathsFor(site, { docs: "../../x" })).toThrow(/outside the repository/);
  });

  test("the site folder inside a nested repository uses that one", () => {
    const outer = tempDir();
    writeTree(outer, { ".git/HEAD": "", "sub/.git/HEAD": "", "sub/docs-site/x": "" });
    const paths = pathsFor(at(outer, "sub/docs-site"), {});
    expect(paths.repoRoot).toBe(join(outer, "sub"));
    expect(dirname(paths.docsDir)).toBe(join(outer, "sub"));
    expect(() => pathsFor(at(outer, "sub/docs-site"), { docs: "../../docs" })).toThrow(ConfigError);
  });
});
