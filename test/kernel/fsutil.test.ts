import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";
import {
  copyFile,
  ensureRealDir,
  isInside,
  MAX_WALK_ENTRIES,
  removeInside,
  replaceDir,
  sha256,
  walkFiles,
  writeJson,
} from "../../src/lib/fsutil.js";
import { at, listTree, readTree, tempDir, writeTree } from "../support/index.js";

type Spec = Record<string, string | { symlink: string } | { dir: true }>;

/**
 * A repository (`repo`, with a README.md) next to a folder that is not part of it (`outside`).
 * `spec` is written under `repo`; give a function to build it from the folders' paths.
 */
function layout(spec: Spec | ((paths: { base: string; outside: string }) => Spec) = {}) {
  const base = tempDir();
  const repo = join(base, "repo");
  const outside = join(base, "outside");
  const entries = typeof spec === "function" ? spec({ base, outside }) : spec;
  writeTree(base, {
    "outside/secret.txt": "secret",
    "outside/folder/inner.md": "inner",
    "repo/README.md": "readme",
    ...Object.fromEntries(Object.entries(entries).map(([path, entry]) => [`repo/${path}`, entry])),
  });
  return { base, repo, outside, docs: join(repo, "docs") };
}

describe("isInside", () => {
  test("is lexical: the folder itself counts unless strict, siblings with the same prefix do not", () => {
    expect(isInside("/a/b", "/a/b/c")).toBe(true);
    expect(isInside("/a/b", "/a/b")).toBe(true);
    expect(isInside("/a/b", "/a/b", { strict: true })).toBe(false);
    expect(isInside("/a/b", "/a/bc")).toBe(false);
    expect(isInside("/a/b", "/a")).toBe(false);
    expect(isInside("/a/b", "/a/b/../x")).toBe(false);
    expect(isInside("/a/b", "/a/b/c/../d")).toBe(true);
    expect(isInside("/a/b", "/a/b/..hidden")).toBe(true);
  });
});

describe("walkFiles", () => {
  test("lists every file, relative, with / separators, sorted by code unit, dot files included", () => {
    const { repo, docs } = layout({
      "docs/b.md": "b",
      "docs/a-b/x.md": "x",
      "docs/a/x.md": "x",
      "docs/.hidden.md": "h",
      "docs/Z.md": "z",
      "docs/empty/": { dir: true },
    });
    expect(walkFiles(docs, { repoRoot: repo })).toEqual({
      files: [".hidden.md", "Z.md", "a-b/x.md", "a/x.md", "b.md"],
      skipped: [],
    });
  });

  test("a missing folder is empty; a file or a folder outside the repository is an error", () => {
    const { repo, docs, outside } = layout({ "docs/a.md": "a" });
    expect(walkFiles(join(repo, "overrides"), { repoRoot: repo })).toEqual({
      files: [],
      skipped: [],
    });
    expect(() => walkFiles(join(repo, "README.md"), { repoRoot: repo })).toThrow(/not a folder/);
    expect(() => walkFiles(outside, { repoRoot: repo })).toThrow(/outside the repository/);
    // A docs folder that is itself a link to somewhere else is outside, whatever its path says.
    symlinkSync(outside, join(repo, "linked-docs"));
    expect(() => walkFiles(join(repo, "linked-docs"), { repoRoot: repo })).toThrow(
      /outside the repository/,
    );
    expect(walkFiles(docs, { repoRoot: repo }).files).toEqual(["a.md"]);
  });

  describe("symbolic links that stay inside the repository are followed", () => {
    test("to a file, to a folder, and through a chain of links", () => {
      const { repo, docs } = layout({
        "docs/real.md": "real",
        "docs/file-link.md": { symlink: "../README.md" },
        "docs/dir-link": { symlink: "../shared" },
        "docs/chain.md": { symlink: "file-link.md" },
        "shared/one.md": "one",
        "shared/deep/two.md": "two",
      });
      expect(walkFiles(docs, { repoRoot: repo })).toEqual({
        files: ["chain.md", "dir-link/deep/two.md", "dir-link/one.md", "file-link.md", "real.md"],
        skipped: [],
      });
    });

    test("when the repository is reached through a link itself (a /var -> /private/var machine)", () => {
      const { base, repo, docs } = layout({
        "docs/a.md": "a",
        "docs/link.md": { symlink: "../README.md" },
      });
      symlinkSync(base, join(base, "alias"));
      const viaAlias = join(base, "alias", "repo");
      expect(walkFiles(join(viaAlias, "docs"), { repoRoot: viaAlias })).toEqual(
        walkFiles(docs, { repoRoot: repo }),
      );
    });
  });

  describe("symbolic links that leave the repository are skipped and reported", () => {
    test("a file and a folder outside", () => {
      const { repo, docs } = layout(({ outside }) => ({
        "docs/ok.md": "ok",
        "docs/leak.md": { symlink: join(outside, "secret.txt") },
        "docs/leak-folder": { symlink: join(outside, "folder") },
        "docs/relative-leak.md": { symlink: "../../outside/secret.txt" },
      }));
      expect(walkFiles(docs, { repoRoot: repo })).toEqual({
        files: ["ok.md"],
        skipped: [
          { path: "leak-folder", reason: "a symbolic link outside the repository" },
          { path: "leak.md", reason: "a symbolic link outside the repository" },
          { path: "relative-leak.md", reason: "a symbolic link outside the repository" },
        ],
      });
    });

    test("a link whose target is a link to the outside is still outside", () => {
      const { repo, docs } = layout(({ outside }) => ({
        "docs/hop.md": { symlink: "stepping-stone" },
        "docs/stepping-stone": { symlink: join(outside, "secret.txt") },
      }));
      const { files, skipped } = walkFiles(docs, { repoRoot: repo });
      expect(files).toEqual([]);
      expect(skipped.map((s) => s.path)).toEqual(["hop.md", "stepping-stone"]);
    });

    test("a link to a folder whose name merely starts like the repository's is outside", () => {
      const { base, repo, docs } = layout({ "docs/ok.md": "ok" });
      writeTree(base, { "repo-extra/file.md": "extra" });
      symlinkSync(join(base, "repo-extra", "file.md"), join(docs, "sneaky.md"));
      expect(walkFiles(docs, { repoRoot: repo }).skipped).toEqual([
        { path: "sneaky.md", reason: "a symbolic link outside the repository" },
      ]);
    });
  });

  describe("symbolic links into .git, node_modules and .docusystem are refused", () => {
    test("inside the repository, they are skipped with their own reason", () => {
      const { repo, docs } = layout({
        "docs/ok.md": "ok",
        ".git/config": "[remote] token",
        "node_modules/pkg/index.js": "x",
        "vendor/lib/node_modules/y.js": "y",
        "docs-site/.docusystem/site/page.md": "staged",
        "docs/git-config.md": { symlink: "../.git/config" },
        "docs/modules": { symlink: "../node_modules" },
        "docs/nested-modules.md": { symlink: "../vendor/lib/node_modules/y.js" },
        "docs/staged": { symlink: "../docs-site/.docusystem" },
      });
      expect(walkFiles(docs, { repoRoot: repo })).toEqual({
        files: ["ok.md"],
        skipped: [
          { path: "git-config.md", reason: "a symbolic link into .git" },
          { path: "modules", reason: "a symbolic link into node_modules" },
          { path: "nested-modules.md", reason: "a symbolic link into node_modules" },
          { path: "staged", reason: "a symbolic link into .docusystem" },
        ],
      });
    });

    test("the site's dist folder is refused when the site folder is given", () => {
      const { repo, docs } = layout({
        "docs/ok.md": "ok",
        "docs-site/dist/index.html": "<html>",
        "docs/built": { symlink: "../docs-site/dist" },
        "docs/page.html": { symlink: "../docs-site/dist/index.html" },
        "other/dist/keep.md": "keep",
        "docs/other": { symlink: "../other/dist" },
      });
      const siteDir = join(repo, "docs-site");
      expect(walkFiles(docs, { repoRoot: repo, siteDir })).toEqual({
        files: ["ok.md", "other/keep.md"],
        skipped: [
          { path: "built", reason: "a symbolic link into the site's dist folder" },
          { path: "page.html", reason: "a symbolic link into the site's dist folder" },
        ],
      });
      // Without the site folder the walk cannot know which dist is the site's.
      expect(walkFiles(docs, { repoRoot: repo }).files).toContain("built/index.html");
    });
  });

  describe("real folders that are never content are not entered", () => {
    test(".git, node_modules and .docusystem at any depth, and the site's dist", () => {
      const { repo } = layout({
        "docs/ok.md": "ok",
        "docs/.git/HEAD": "ref",
        "docs/node_modules/pkg/index.md": "x",
        "docs/guide/node_modules/deep.md": "x",
        "docs/guide/page.md": "p",
        "docs-site/.docusystem/site/x.md": "x",
        "docs-site/dist/index.html": "h",
        "docs-site/docusystem.config.json": "{}",
      });
      // The Markdown folder is the repository root itself: `docs: ".."`.
      const siteDir = join(repo, "docs-site");
      const { files, skipped } = walkFiles(repo, { repoRoot: repo, siteDir });
      expect(files).toEqual([
        "README.md",
        "docs-site/docusystem.config.json",
        "docs/guide/page.md",
        "docs/ok.md",
      ]);
      expect(skipped).toEqual([]);
    });
  });

  describe("cycles are cut", () => {
    test("a link to the folder that holds it", () => {
      const { repo, docs } = layout({
        "docs/a.md": "a",
        "docs/loop": { symlink: "." },
        "docs/sub/b.md": "b",
        "docs/sub/up": { symlink: ".." },
      });
      const { files, skipped } = walkFiles(docs, { repoRoot: repo });
      expect(files).toEqual(["a.md", "sub/b.md"]);
      expect(skipped).toEqual([
        { path: "loop", reason: "a symbolic link back to a folder that contains it (a cycle)" },
        {
          path: "sub/up",
          reason: "a symbolic link back to a folder that contains it (a cycle)",
        },
      ]);
    });

    test("a link to a sibling folder publishes both, whichever of the two sorts first", () => {
      for (const [link, folder] of [
        ["a", "b"],
        ["b", "a"],
      ] as const) {
        const { repo, docs } = layout({
          [`docs/${folder}/page.md`]: "p",
          [`docs/${link}`]: { symlink: folder },
        });
        expect(walkFiles(docs, { repoRoot: repo })).toEqual({
          files: ["a/page.md", "b/page.md"],
          skipped: [],
        });
      }
    });

    test("two links that point at each other's folders", () => {
      const { repo, docs } = layout({
        "docs/one/to-two": { symlink: "../two" },
        "docs/one/o.md": "o",
        "docs/two/to-one": { symlink: "../one" },
        "docs/two/t.md": "t",
      });
      const { files, skipped } = walkFiles(docs, { repoRoot: repo });
      expect(files).toEqual(["one/o.md", "one/to-two/t.md", "two/t.md", "two/to-one/o.md"]);
      expect(skipped.map((s) => s.path)).toEqual(["one/to-two/to-one", "two/to-one/to-two"]);
    });

    test("a link out of the walked folder and back into it", () => {
      const { repo, docs } = layout({
        "docs/a.md": "a",
        "docs/up": { symlink: ".." },
      });
      expect(walkFiles(docs, { repoRoot: repo })).toEqual({
        files: ["a.md", "up/README.md"],
        skipped: [
          { path: "up/docs", reason: "a folder that a symbolic link leads back into (a cycle)" },
        ],
      });
    });
  });

  describe("the walk is bounded", () => {
    /** `d0` holds two links to `d1`, which holds two links to `d2`, ...: 2^depth paths to one file. */
    const diamond = (depth: number) => {
      const spec: Spec = { [`docs/d${depth}/leaf.md`]: "leaf" };
      for (let i = 0; i < depth; i++) {
        spec[`docs/d${i}/a`] = { symlink: `../d${i + 1}` };
        spec[`docs/d${i}/b`] = { symlink: `../d${i + 1}` };
      }
      return layout(spec);
    };

    test("links that lead to the same folders again and again are an error, not a very long walk", () => {
      const { repo, docs } = diamond(30); // 2^30 paths if every link were followed
      expect(() => walkFiles(docs, { repoRoot: repo, maxEntries: 500 })).toThrow(
        /has more than 500 files and folders once symbolic links are followed/,
      );
    });

    test("the same tree is fine when it is small enough, and the limit counts entries read", () => {
      const { repo, docs } = diamond(3);
      const { files } = walkFiles(docs, { repoRoot: repo });
      // d0 reaches the leaf by 8 paths, d1 by 4, d2 by 2, d3 by 1: every link is followed.
      expect(files).toHaveLength(15);
      expect(() => walkFiles(docs, { repoRoot: repo, maxEntries: 5 })).toThrow(/more than 5/);
      expect(() => walkFiles(docs, { repoRoot: repo, maxEntries: 100 })).not.toThrow();
    });

    test("the default limit is large enough for any documentation tree", () => {
      expect(MAX_WALK_ENTRIES).toBeGreaterThanOrEqual(50_000);
      const { repo } = layout({ "docs/a.md": "a" });
      expect(walkFiles(join(repo, "docs"), { repoRoot: repo }).files).toEqual(["a.md"]);
    });
  });

  describe("the names of the refused folders are compared without regard to case", () => {
    test("a link into .GIT or Node_Modules is refused (on a case-insensitive file system it is .git)", () => {
      const { repo, docs } = layout({
        "docs/ok.md": "ok",
        ".GIT/config": "[remote] token",
        "Node_Modules/pkg/index.js": "x",
        "docs/git-config.md": { symlink: "../.GIT/config" },
        "docs/modules": { symlink: "../Node_Modules" },
      });
      expect(walkFiles(docs, { repoRoot: repo })).toEqual({
        files: ["ok.md"],
        skipped: [
          { path: "git-config.md", reason: "a symbolic link into .git" },
          { path: "modules", reason: "a symbolic link into node_modules" },
        ],
      });
    });

    test("real folders with those names are not entered either", () => {
      const { repo, docs } = layout({
        "docs/ok.md": "ok",
        "docs/.GIT/HEAD": "ref",
        "docs/Node_Modules/pkg/index.md": "x",
      });
      expect(walkFiles(docs, { repoRoot: repo })).toEqual({ files: ["ok.md"], skipped: [] });
    });
  });

  test("links that do not resolve are skipped and reported", () => {
    const { repo, docs } = layout({
      "docs/ok.md": "ok",
      "docs/dangling.md": { symlink: "nowhere.md" },
      "docs/self": { symlink: "self" },
    });
    expect(walkFiles(docs, { repoRoot: repo })).toEqual({
      files: ["ok.md"],
      skipped: [
        { path: "dangling.md", reason: "a symbolic link that does not resolve" },
        { path: "self", reason: "a symbolic link that does not resolve" },
      ],
    });
  });

  test("a special file is skipped and reported", () => {
    const { repo, docs } = layout({ "docs/ok.md": "ok" });
    const made = spawnSync("mkfifo", [join(docs, "pipe")]);
    if (made.status !== 0) return; // no mkfifo on this machine
    expect(walkFiles(docs, { repoRoot: repo })).toEqual({
      files: ["ok.md"],
      skipped: [{ path: "pipe", reason: "not a regular file or a folder" }],
    });
  });
});

describe("copyFile", () => {
  test("copies the bytes, creates the folders above, and makes a plain writable file", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "from.bin"), Buffer.from([0, 1, 2, 255]));
    chmodSync(join(dir, "from.bin"), 0o444);
    copyFile(join(dir, "from.bin"), at(dir, "a/b/to.bin"));
    expect([...readFileSync(at(dir, "a/b/to.bin"))]).toEqual([0, 1, 2, 255]);
    expect(lstatSync(at(dir, "a/b/to.bin")).mode & 0o777).toBe(0o644);
    // ... so that the next run can replace it
    copyFile(join(dir, "from.bin"), at(dir, "a/b/to.bin"));
    expect(readFileSync(at(dir, "a/b/to.bin")).length).toBe(4);
  });

  test("a link as the source is read through; the copy is never a link", () => {
    const dir = tempDir();
    writeTree(dir, { "real.txt": "real", "link.txt": { symlink: "real.txt" } });
    copyFile(join(dir, "link.txt"), join(dir, "copy.txt"));
    expect(lstatSync(join(dir, "copy.txt")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(dir, "copy.txt"), "utf8")).toBe("real");
  });

  test("a link or a read-only file at the target is replaced, never written through", () => {
    const dir = tempDir();
    writeTree(dir, {
      "from.txt": "new",
      "victim.txt": "victim",
      "to-link.txt": { symlink: "victim.txt" },
      "readonly.txt": "old",
    });
    chmodSync(join(dir, "readonly.txt"), 0o444);
    copyFile(join(dir, "from.txt"), join(dir, "to-link.txt"));
    expect(lstatSync(join(dir, "to-link.txt")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(dir, "to-link.txt"), "utf8")).toBe("new");
    expect(readFileSync(join(dir, "victim.txt"), "utf8")).toBe("victim");
    copyFile(join(dir, "from.txt"), join(dir, "readonly.txt"));
    expect(readFileSync(join(dir, "readonly.txt"), "utf8")).toBe("new");
  });

  test("refuses a folder as the source or the target, and the same file", () => {
    const dir = tempDir();
    writeTree(dir, { "file.txt": "x", "folder/inner.txt": "i", alias: { symlink: "folder" } });
    expect(() => copyFile(join(dir, "folder"), join(dir, "x"))).toThrow(/not a file/);
    expect(() => copyFile(join(dir, "file.txt"), join(dir, "folder"))).toThrow();
    expect(readFileSync(join(dir, "folder", "inner.txt"), "utf8")).toBe("i");
    expect(() => copyFile(join(dir, "file.txt"), join(dir, "file.txt"))).toThrow(/same file/);
    expect(() =>
      copyFile(join(dir, "folder", "inner.txt"), join(dir, "alias", "inner.txt")),
    ).toThrow(/same file/);
    expect(readFileSync(join(dir, "folder", "inner.txt"), "utf8")).toBe("i");
    expect(() => copyFile(join(dir, "missing.txt"), join(dir, "y"))).toThrow();
  });
});

describe("writeJson", () => {
  test("two spaces, a trailing newline, folders created", () => {
    const dir = tempDir();
    writeJson(at(dir, "a/b.json"), { x: 1, list: [1, 2], nested: { y: "z" } });
    expect(readFileSync(at(dir, "a/b.json"), "utf8")).toBe(
      '{\n  "x": 1,\n  "list": [\n    1,\n    2\n  ],\n  "nested": {\n    "y": "z"\n  }\n}\n',
    );
  });

  test("replaces a link instead of writing through it, and refuses what is not JSON", () => {
    const dir = tempDir();
    writeTree(dir, { "victim.json": "{}", "link.json": { symlink: "victim.json" } });
    writeJson(join(dir, "link.json"), { a: 1 });
    expect(lstatSync(join(dir, "link.json")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(dir, "victim.json"), "utf8")).toBe("{}");
    expect(() => writeJson(join(dir, "u.json"), undefined)).toThrow(TypeError);
    expect(existsSync(join(dir, "u.json"))).toBe(false);
  });
});

describe("removeInside", () => {
  test("removes a file or a whole folder inside the parent, and a missing path is fine", () => {
    const dir = tempDir();
    writeTree(dir, {
      "site/.docusystem/site/a/b.txt": "b",
      "site/dist/i.html": "i",
      "keep.txt": "k",
    });
    removeInside(at(dir, "site/.docusystem/site"), at(dir, "site/.docusystem"));
    expect(listTree(dir)).toEqual([
      "keep.txt",
      "site/",
      "site/.docusystem/",
      "site/dist/",
      "site/dist/i.html",
    ]);
    removeInside(at(dir, "site/dist/i.html"), at(dir, "site"));
    removeInside(at(dir, "site/dist/gone.html"), at(dir, "site"));
    removeInside(at(dir, "site/nothing/at/all"), at(dir, "site"));
    expect(listTree(dir)).toEqual(["keep.txt", "site/", "site/.docusystem/", "site/dist/"]);
  });

  test("refuses the parent itself, its parents, siblings, and paths that climb out", () => {
    const dir = tempDir();
    writeTree(dir, { "site/a.txt": "a", "site-extra/b.txt": "b", "c.txt": "c" });
    const before = listTree(dir);
    const parent = at(dir, "site");
    for (const path of [
      parent,
      `${parent}/`,
      dir,
      at(dir, "site-extra"),
      at(dir, "site-extra/b.txt"),
      at(dir, "c.txt"),
      `${parent}/../c.txt`,
      `${parent}/../site-extra`,
      "/",
    ]) {
      expect(() => removeInside(path, parent), path).toThrow(/not inside/);
    }
    expect(listTree(dir)).toEqual(before);
  });

  test("works with relative paths", () => {
    const dir = tempDir();
    writeTree(dir, { "site/dist/i.html": "i", "elsewhere/x.txt": "x" });
    const rel = (path: string): string => relative(process.cwd(), at(dir, path));
    removeInside(rel("site/dist"), rel("site"));
    expect(() => removeInside(rel("elsewhere"), rel("site"))).toThrow(/not inside/);
    expect(listTree(dir)).toEqual(["elsewhere/", "elsewhere/x.txt", "site/"]);
  });

  test("refuses to reach through a symbolic link folder, and removes a final link without following it", () => {
    const dir = tempDir();
    writeTree(dir, {
      "outside/precious.txt": "precious",
      "site/.docusystem": { symlink: "../outside" },
      "site/dist": { symlink: "../outside" },
    });
    expect(() => removeInside(at(dir, "site/.docusystem/precious.txt"), at(dir, "site"))).toThrow(
      /symbolic link/,
    );
    expect(readFileSync(at(dir, "outside/precious.txt"), "utf8")).toBe("precious");
    // The link itself may be removed (it is what is inside the parent); its target is untouched.
    removeInside(at(dir, "site/dist"), at(dir, "site"));
    expect(existsSync(at(dir, "site/dist"))).toBe(false);
    expect(readFileSync(at(dir, "outside/precious.txt"), "utf8")).toBe("precious");
  });

  test("does not follow links inside the removed folder", () => {
    const dir = tempDir();
    writeTree(dir, {
      "outside/precious.txt": "precious",
      "site/work/inner/link": { symlink: "../../../outside" },
    });
    removeInside(at(dir, "site/work"), at(dir, "site"));
    expect(existsSync(at(dir, "site/work"))).toBe(false);
    expect(readFileSync(at(dir, "outside/precious.txt"), "utf8")).toBe("precious");
  });
});

describe("ensureRealDir", () => {
  test("creates a missing folder and its parents, accepts a real one, refuses a link or a file", () => {
    const dir = tempDir();
    writeTree(dir, { "elsewhere/x": "x", "file.txt": "f", link: { symlink: "elsewhere" } });
    ensureRealDir(at(dir, "a/b/c"));
    expect(statSync(at(dir, "a/b/c")).isDirectory()).toBe(true);
    ensureRealDir(at(dir, "a/b/c"));
    ensureRealDir(at(dir, "elsewhere"));
    expect(() => ensureRealDir(at(dir, "link"))).toThrow(/symbolic link/);
    expect(() => ensureRealDir(at(dir, "file.txt"))).toThrow(/not a folder/);
  });
});

describe("replaceDir", () => {
  test("makes `to` a copy of `from`, removes what was there, and leaves nothing behind", () => {
    const dir = tempDir();
    writeTree(dir, {
      "from/index.html": "new",
      "from/assets/app.js": "js",
      "from/empty/": { dir: true },
      "to/index.html": "old",
      "to/stale.html": "stale",
    });
    chmodSync(at(dir, "from/index.html"), 0o444);
    replaceDir(at(dir, "from"), at(dir, "to"));
    expect(readTree(at(dir, "to"))).toEqual({ "index.html": "new", "assets/app.js": "js" });
    expect(statSync(at(dir, "to/empty")).isDirectory()).toBe(true);
    expect(statSync(at(dir, "to/index.html")).mode & 0o777).toBe(0o644);
    // `from` is copied, not moved
    expect(readTree(at(dir, "from"))).toEqual({ "index.html": "new", "assets/app.js": "js" });
    expect(listTree(dir).filter((p) => /\.(tmp|old)-/.test(p))).toEqual([]);
  });

  test("creates `to` and its parents when they do not exist, and replaces a file", () => {
    const dir = tempDir();
    writeTree(dir, { "from/a.txt": "a", "file-target": "i am a file" });
    replaceDir(at(dir, "from"), at(dir, "deep/er/to"));
    expect(readTree(at(dir, "deep/er/to"))).toEqual({ "a.txt": "a" });
    replaceDir(at(dir, "from"), at(dir, "file-target"));
    expect(readTree(at(dir, "file-target"))).toEqual({ "a.txt": "a" });
  });

  test("replaces a link at `to` with the folder, leaving the link's target alone", () => {
    const dir = tempDir();
    writeTree(dir, {
      "from/a.txt": "a",
      "elsewhere/keep.txt": "keep",
      to: { symlink: "elsewhere" },
    });
    replaceDir(at(dir, "from"), at(dir, "to"));
    expect(lstatSync(at(dir, "to")).isSymbolicLink()).toBe(false);
    expect(readTree(at(dir, "to"))).toEqual({ "a.txt": "a" });
    expect(readTree(at(dir, "elsewhere"))).toEqual({ "keep.txt": "keep" });
  });

  test("a failed copy leaves `to` exactly as it was and removes the partial copy", () => {
    const dir = tempDir();
    writeTree(dir, {
      "from/a.txt": "a",
      "from/sub/link": { symlink: "../a.txt" },
      "from/z.txt": "z",
      "to/old.txt": "old",
    });
    const before = listTree(at(dir, "to"));
    expect(() => replaceDir(at(dir, "from"), at(dir, "to"))).toThrow(/symbolic link/);
    expect(listTree(at(dir, "to"))).toEqual(before);
    expect(readTree(at(dir, "to"))).toEqual({ "old.txt": "old" });
    expect(listTree(dir).filter((p) => /\.(tmp|old)-/.test(p))).toEqual([]);
  });

  test("refuses folders that overlap, and a source that is not a folder", () => {
    const dir = tempDir();
    writeTree(dir, { "a/b/c.txt": "c", "file.txt": "f" });
    expect(() => replaceDir(at(dir, "a"), at(dir, "a/b"))).toThrow(/overlap/);
    expect(() => replaceDir(at(dir, "a/b"), at(dir, "a"))).toThrow(/overlap/);
    expect(() => replaceDir(at(dir, "a"), at(dir, "a"))).toThrow(/overlap/);
    expect(() => replaceDir(at(dir, "file.txt"), at(dir, "x"))).toThrow(/not a folder/);
    expect(() => replaceDir(at(dir, "missing"), at(dir, "x"))).toThrow();
    expect(readTree(at(dir, "a"))).toEqual({ "b/c.txt": "c" });
  });

  test("removes the leftovers of runs that died, and only those", () => {
    const dir = tempDir();
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    writeTree(dir, {
      "from/a.txt": "a",
      [`dist.tmp-${dead}/half.txt`]: "half",
      [`dist.old-${dead}/old.txt`]: "old",
      [`dist.tmp-${process.ppid}/other.txt`]: "a process that is still running",
      "dist.tmp-notapid/x.txt": "not ours",
      "dist.tmpx-1/x.txt": "not ours",
      "other.tmp-1/x.txt": "not ours",
    });
    replaceDir(at(dir, "from"), at(dir, "dist"));
    expect(listTree(dir).filter((p) => p.indexOf("/") === p.length - 1)).toEqual(
      [
        "dist.tmp-notapid/",
        `dist.tmp-${process.ppid}/`,
        "dist.tmpx-1/",
        "dist/",
        "from/",
        "other.tmp-1/",
      ].sort(),
    );
  });
});

describe("sha256", () => {
  test("is the hex SHA-256 of the contents", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "abc"), "abc");
    writeFileSync(join(dir, "empty"), "");
    expect(sha256(join(dir, "abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(sha256(join(dir, "empty"))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(() => sha256(join(dir, "missing"))).toThrow();
  });
});
