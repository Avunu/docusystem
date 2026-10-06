import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  gitRootOf,
  normalizeRemote,
  originRemote,
  repoName,
  runGit,
} from "../../src/lib/gitremote.js";
import { initRepo, tempDir } from "../support/index.js";
import { envFor, makeRepo } from "./support/shell.js";

describe("normalizeRemote", () => {
  test.each([
    ["git@github.com:Avunu/frappe-nix.git", "https://github.com/Avunu/frappe-nix"],
    ["git@github.com:Avunu/frappe-nix", "https://github.com/Avunu/frappe-nix"],
    ["github.com:Avunu/frappe-nix.git", "https://github.com/Avunu/frappe-nix"],
    ["ssh://git@github.com/Avunu/frappe-nix.git", "https://github.com/Avunu/frappe-nix"],
    ["ssh://git@github.com:22/Avunu/frappe-nix", "https://github.com/Avunu/frappe-nix"],
    ["git://github.com/Avunu/frappe-nix.git", "https://github.com/Avunu/frappe-nix"],
    ["https://github.com/Avunu/frappe-nix.git", "https://github.com/Avunu/frappe-nix"],
    ["https://github.com/Avunu/frappe-nix/", "https://github.com/Avunu/frappe-nix"],
    ["https://github.com/Avunu/frappe-nix", "https://github.com/Avunu/frappe-nix"],
    [
      "  https://github.com/Avunu/erpnext_taskview.git\n",
      "https://github.com/Avunu/erpnext_taskview",
    ],
    ["https://GitHub.com/Avunu/frappe-nix", "https://github.com/Avunu/frappe-nix"],
    ["https://user@github.com/Avunu/frappe-nix", "https://github.com/Avunu/frappe-nix"],
  ])("%s", (remote, expected) => {
    expect(normalizeRemote(remote)).toBe(expected);
  });

  test("never carries credentials into the result", () => {
    const result = normalizeRemote(
      "https://x-access-token:ghs_secret@github.com/Avunu/frappe-nix.git",
    );
    expect(result).toBe("https://github.com/Avunu/frappe-nix");
    expect(result).not.toContain("ghs_secret");
  });

  test.each([
    "https://gitlab.com/Avunu/frappe-nix",
    "git@gitlab.com:Avunu/frappe-nix.git",
    "https://github.com.evil.example/Avunu/frappe-nix",
    "https://example.com/github.com/Avunu/frappe-nix",
    "https://github.com/Avunu",
    "https://github.com/Avunu/a/b",
    "../frappe-nix",
    "/srv/git/frappe-nix.git",
    "file:///srv/git/frappe-nix.git",
    "https://github.com/Avunu/..",
    "",
  ])("is not a GitHub repository: %j", (remote) => {
    expect(normalizeRemote(remote)).toBeNull();
  });
});

test("repoName is the last segment", () => {
  expect(repoName("https://github.com/Avunu/frappe-nix")).toBe("frappe-nix");
});

describe("gitRootOf", () => {
  test("finds the repository from a folder inside it, and from its root", () => {
    const root = makeRepo({ files: { "a/b/c/file.txt": "x" } });
    expect(gitRootOf(join(root, "a", "b", "c"))).toBe(root);
    expect(gitRootOf(root)).toBe(root);
  });

  test("a `.git` file (a worktree or a submodule) marks a root too", () => {
    const dir = tempDir();
    writeFileSync(join(dir, ".git"), "gitdir: /elsewhere/.git/worktrees/x\n");
    mkdirSync(join(dir, "sub"));
    expect(gitRootOf(join(dir, "sub"))).toBe(dir);
  });

  test("is null outside any repository, and for a folder that does not exist", () => {
    expect(gitRootOf("/")).toBeNull();
    expect(gitRootOf(join(tempDir(), "missing"))).toBeNull();
  });
});

describe("originRemote and runGit", () => {
  test("reads the origin remote", () => {
    const root = makeRepo({ origin: "git@github.com:Avunu/frappe-nix.git" });
    expect(originRemote(root, envFor(root))).toBe("git@github.com:Avunu/frappe-nix.git");
  });

  test("is null for a repository without one", () => {
    const root = makeRepo({ origin: null });
    expect(originRemote(root, envFor(root))).toBeNull();
  });

  test("git sees only PATH and HOME of the environment it is given", () => {
    const root = tempDir();
    initRepo(root);
    // A variable that git itself reads and that the child must not see: it would point git elsewhere.
    const env = { ...envFor(root), GIT_DIR: join(root, "nowhere"), GITHUB_TOKEN: "secret" };
    expect(runGit(["rev-parse", "--git-dir"], { cwd: root, env }).stdout.trim()).toBe(".git");
  });

  test("reports a missing git instead of throwing", () => {
    const result = runGit(["--version"], { env: { PATH: "/nonexistent" } });
    expect(result.missing).toBe(true);
    expect(result.status).toBeNull();
  });
});
