import { describe, expect, test } from "vitest";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { listTree, readTree, tempDir, writeTree } from "../support/index.js";
import { moveLeadingComment } from "../../src/lib/frontmatter.js";
import * as stage from "../../src/lib/stage.js";
import {
  resolveLink,
  stageDocs,
  stageMarkdown,
  stageSite,
  type StageOptions,
} from "../../src/lib/stage.js";
import type { DocsConfig } from "../../src/lib/types.js";
import { makeTree, pathsIn } from "./helpers.js";

/** A repository: docs/ with a few pages, and files elsewhere that the docs link to. */
function repo(extra: Record<string, string> = {}) {
  const root = makeTree({
    "README.md": "# The repository\n",
    LICENSE: "MIT",
    "CONTRIBUTING.md": "# Contributing\n",
    "lib/x.nix": "{}",
    "worker/README.md": "# Worker\n",
    "assets/logo.png": "png",
    "docs/README.md": "# Home\n",
    "docs/chat.md": "# Chat\n",
    "docs/guides/setup.md": "# Setup\n",
    "docs/img/flow.png": "png",
    ...extra,
  });
  return {
    root,
    options: {
      source: join(root, "docs"),
      dest: join(root, "site", ".generated", "docs"),
      repoRoot: root,
      repoUrl: "https://github.com/Avunu/app",
      branch: "main",
    },
  };
}

test("a link that resolves inside docs/ is left for Jx", () => {
  const { options } = repo();
  expect(resolveLink("chat.md", "README.md", false, options)).toBeNull();
  expect(resolveLink("../chat.md#x", "guides/setup.md", false, options)).toBeNull();
  expect(resolveLink("img/flow.png", "README.md", true, options)).toBeNull();
  expect(resolveLink("guides/", "README.md", false, options)).toBeNull();
});

test("links to files outside docs/ become GitHub URLs: blob, tree, and raw for an image", () => {
  const { options } = repo();
  const base = "https://github.com/Avunu/app";
  expect(resolveLink("../CONTRIBUTING.md", "README.md", false, options)).toBe(
    `${base}/blob/main/CONTRIBUTING.md`,
  );
  expect(resolveLink("../lib/x.nix#L3", "README.md", false, options)).toBe(
    `${base}/blob/main/lib/x.nix#L3`,
  );
  expect(resolveLink("../../worker", "guides/setup.md", false, options)).toBe(
    `${base}/tree/main/worker`,
  );
  expect(resolveLink("../assets/logo.png", "README.md", true, options)).toBe(
    `${base}/raw/main/assets/logo.png`,
  );
  // The same file linked as a page link, not an image, is a blob.
  expect(resolveLink("../assets/logo.png", "README.md", false, options)).toBe(
    `${base}/blob/main/assets/logo.png`,
  );
});

test("links written from the repository root, as in a README that was copied into docs/, are fixed", () => {
  const { options } = repo();
  const base = "https://github.com/Avunu/app";
  // Outside docs/: GitHub.
  expect(resolveLink("worker/README.md", "README.md", false, options)).toBe(
    `${base}/blob/main/worker/README.md`,
  );
  expect(resolveLink("LICENSE", "README.md", false, options)).toBe(`${base}/blob/main/LICENSE`);
  expect(resolveLink("lib/x.nix", "guides/setup.md", false, options)).toBe(
    `${base}/blob/main/lib/x.nix`,
  );
  // Inside docs/: relative to the file, so Jx can resolve the page.
  expect(resolveLink("docs/chat.md", "README.md", false, options)).toBe("chat.md");
  expect(resolveLink("docs/chat.md#top", "guides/setup.md", false, options)).toBe("../chat.md#top");
  expect(resolveLink("docs/guides/setup.md", "README.md", false, options)).toBe("guides/setup.md");
  expect(resolveLink("docs/", "README.md", false, options)).toBe("./");
});

test("a path that leaves docs/ and comes back in is written as the page's own relative path", () => {
  const { options } = repo();
  expect(resolveLink("../docs/chat.md", "README.md", false, options)).toBe("chat.md");
  expect(resolveLink("../../docs/chat.md#top", "guides/setup.md", false, options)).toBe(
    "../chat.md#top",
  );
  expect(resolveLink("../docs/", "README.md", false, options)).toBe("./");
  // ./ and a/../ are fine for Jx and stay as written.
  expect(resolveLink("./chat.md", "README.md", false, options)).toBeNull();
  expect(resolveLink("guides/../chat.md", "README.md", false, options)).toBeNull();
});

test("what cannot be resolved, and what is not a repository path, is left alone", () => {
  const { options } = repo();
  for (const value of [
    "https://example.com/a.md",
    "mailto:x@example.com",
    "#section",
    "/absolute/path",
    "//cdn.example.com/x",
    "",
    "missing.md",
    "../../../../etc/passwd",
    "?query",
  ])
    expect(resolveLink(value, "README.md", false, options)).toBeNull();
});

test("percent-encoded paths are decoded to find the file and encoded again in the URL", () => {
  const { options } = repo({ "docs/My Page.md": "# x\n", "My Notes/a (1).md": "# x\n" });
  expect(resolveLink("My%20Page.md", "README.md", false, options)).toBeNull();
  expect(resolveLink("My%20Notes/a%20(1).md", "README.md", false, options)).toBe(
    "https://github.com/Avunu/app/blob/main/My%20Notes/a%20%281%29.md",
  );
});

test("the link memo of a run changes the cost, not the answer, and is per folder", () => {
  const { options } = repo({ "docs/guides/LICENSE": "a LICENSE inside guides/" });
  const memo = new Map<string, string | null>();
  const link = (value: string, file: string) => resolveLink(value, file, false, options, memo);
  // The same text means two things in two folders: the memo must not mix them up.
  expect(link("LICENSE", "README.md")).toBe("https://github.com/Avunu/app/blob/main/LICENSE");
  expect(link("LICENSE", "guides/setup.md")).toBeNull();
  expect(link("LICENSE", "README.md")).toBe("https://github.com/Avunu/app/blob/main/LICENSE");
  expect(link("LICENSE", "guides/setup.md")).toBeNull();
  expect(memo.size).toBe(2);
  // Images and pages are asked about separately (an image of a file outside docs/ is raw).
  expect(resolveLink("../assets/logo.png", "README.md", true, options, memo)).toContain("/raw/");
  expect(resolveLink("../assets/logo.png", "README.md", false, options, memo)).toContain("/blob/");
  const source = "[a](LICENSE) [b](docs/chat.md) ![c](assets/logo.png)\n";
  expect(stageMarkdown(source, "README.md", options, new Map())).toEqual(
    stageMarkdown(source, "README.md", options),
  );
});

test("stageMarkdown rewrites links and images outside code, and reports each one", () => {
  const { options } = repo();
  const source = [
    "# Home",
    "See [chat](docs/chat.md), [worker](worker/README.md) and ![logo](assets/logo.png).",
    "",
    "```md",
    "[worker](worker/README.md) stays in a fence",
    "```",
    "",
    "Inline `[worker](worker/README.md)` stays too, and [ok](chat.md) is fine.",
    "[![badge](assets/logo.png)](LICENSE)",
  ].join("\n");
  const { text, links } = stageMarkdown(source, "README.md", options);
  expect(text.split("\n")).toEqual([
    "# Home",
    "See [chat](chat.md), [worker](https://github.com/Avunu/app/blob/main/worker/README.md) and ![logo](https://github.com/Avunu/app/raw/main/assets/logo.png).",
    "",
    "```md",
    "[worker](worker/README.md) stays in a fence",
    "```",
    "",
    "Inline `[worker](worker/README.md)` stays too, and [ok](chat.md) is fine.",
    "[![badge](https://github.com/Avunu/app/raw/main/assets/logo.png)](https://github.com/Avunu/app/blob/main/LICENSE)",
  ]);
  expect(links.map((l) => [l.line, l.from])).toEqual([
    [2, "docs/chat.md"],
    [2, "worker/README.md"],
    [2, "assets/logo.png"],
    [9, "assets/logo.png"],
    [9, "LICENSE"],
  ]);
  expect(stageMarkdown("no links here\r\nsecond\r\n", "README.md", options).text).toBe(
    "no links here\r\nsecond\r\n",
  );
});

test("moveLeadingComment is reachable from the staging module", () => {
  expect(stage.moveLeadingComment).toBe(moveLeadingComment);
});

test("a comment above the frontmatter is moved below it, and nothing else is touched", () => {
  const stamped =
    "<!-- Copyright (c) 2026, Avunu LLC -->\n\n---\ntitle: A\norder: 2\n---\n\n# A\n\ntext\n";
  expect(moveLeadingComment(stamped)).toBe(
    "---\ntitle: A\norder: 2\n---\n\n<!-- Copyright (c) 2026, Avunu LLC -->\n\n# A\n\ntext\n",
  );
  expect(moveLeadingComment("<!-- a -->\n<!-- b -->\n---\ntitle: A\n---\nbody")).toBe(
    "---\ntitle: A\n---\n\n<!-- a -->\n<!-- b -->\n\nbody",
  );
  // No frontmatter behind the comment, or no comment: nothing to do.
  expect(moveLeadingComment("<!-- c -->\n\n# Title\n")).toBeNull();
  expect(moveLeadingComment("---\ntitle: A\n---\n<!-- c -->\n")).toBeNull();
  expect(moveLeadingComment("# Title\n")).toBeNull();
  // A multi-line comment, as the Frappe copyright hook writes it.
  expect(
    moveLeadingComment(
      "<!-- Copyright (c) 2026\nFor license information, see license.txt-->\n\n---\ntitle: B\n---\nx",
    ),
  ).toContain("---\ntitle: B\n---\n\n<!-- Copyright (c) 2026\nFor license");
});

test("stageDocs copies the folder, fixes Markdown, skips dot folders and node_modules", () => {
  const { options } = repo({
    "docs/.obsidian/app.json": "{}",
    "docs/node_modules/x/index.js": "x",
    "docs/guides/notes.md": "[w](../../worker/README.md)\n",
  });
  const result = stageDocs(options);
  expect(result.files).toBe(5);
  expect(result.links).toHaveLength(1);
  expect(readFileSync(join(options.dest, "guides", "notes.md"), "utf8")).toBe(
    "[w](https://github.com/Avunu/app/blob/main/worker/README.md)\n",
  );
  expect(readFileSync(join(options.dest, "img", "flow.png"), "utf8")).toBe("png");
  expect(existsSync(join(options.dest, ".obsidian"))).toBe(false);
  expect(existsSync(join(options.dest, "node_modules"))).toBe(false);
});

test("staging again writes only what changed and removes what left docs/", () => {
  const { root, options } = repo();
  expect(stageDocs(options).written).toBe(4);
  const file = join(options.dest, "chat.md");
  const stamp = statSync(file).mtimeMs;
  utimesSync(file, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  const second = stageDocs(options);
  expect(second.written).toBe(0);
  expect(second.removed).toBe(0);
  expect(statSync(file).mtimeMs).toBeLessThan(stamp);
  writeFileSync(join(root, "docs", "chat.md"), "# Changed\n");
  mkdirSync(join(options.dest, "gone"), { recursive: true });
  writeFileSync(join(options.dest, "gone", "old.md"), "x");
  writeFileSync(join(options.dest, "stale.md"), "x");
  const third = stageDocs(options);
  expect(third.written).toBe(1);
  expect(third.removed).toBe(2);
  expect(existsSync(join(options.dest, "stale.md"))).toBe(false);
  expect(existsSync(join(options.dest, "gone"))).toBe(false);
});

test("a missing docs folder is an error that names it", () => {
  const { options } = repo();
  expect(() => stageDocs({ ...options, source: join(options.source, "nope") })).toThrow(
    /does not exist/,
  );
});

test("staging again writes nothing, and a file that is not UTF-8 or has mixed line endings stays as it was", () => {
  const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]); // "café\n" in Latin-1
  const { options } = repo({
    "docs/latin.md": latin1.toString("latin1"),
    "docs/mixed.md": "one\r\ntwo\nthree\r\n",
  });
  writeFileSync(join(options.source, "latin.md"), latin1);
  stageDocs(options);
  expect(readFileSync(join(options.dest, "latin.md")).equals(latin1)).toBe(true);
  expect(readFileSync(join(options.dest, "mixed.md"), "utf8")).toBe("one\r\ntwo\nthree\r\n");
  // Rewriting a link keeps the line ending of every line.
  writeFileSync(join(options.source, "mixed.md"), "[w](worker/README.md)\r\ntwo\n[l](LICENSE)\r\n");
  stageDocs(options);
  expect(readFileSync(join(options.dest, "mixed.md"), "utf8")).toBe(
    "[w](https://github.com/Avunu/app/blob/main/worker/README.md)\r\ntwo\n[l](https://github.com/Avunu/app/blob/main/LICENSE)\r\n",
  );
});

test("a file that became a folder, and a folder that became a file, replace what was staged", () => {
  const { root, options } = repo({ "docs/a": "plain file", "docs/b/c.md": "# C\n" });
  stageDocs(options);
  rmSync(join(root, "docs", "a"));
  rmSync(join(root, "docs", "b"), { recursive: true });
  writeTree(root, { "docs/a/inner.md": "# Inner\n", "docs/b": "now a file" });
  const result = stageDocs(options);
  expect(result.removed).toBe(2);
  expect(readTree(options.dest)).toEqual({
    "README.md": "# Home\n",
    "chat.md": "# Chat\n",
    "guides/setup.md": "# Setup\n",
    "img/flow.png": "png",
    "a/inner.md": "# Inner\n",
    b: "now a file",
  });
});

describe("the symlink policy (4.1)", () => {
  /** A repository with a sibling folder that is not part of it. */
  function layout(spec: Record<string, string | { symlink: string }>) {
    const base = tempDir("docusystem-stage-");
    writeTree(base, {
      "outside/secret.txt": "do not publish",
      "outside/page.md": "# Outside\n",
      "repo/README.md": "# Repository\n",
      "repo/docs/README.md": "# Home\n",
      "repo/shared/note.md": "# Shared note\n",
      "repo/.git/config": "[remote]",
      ...Object.fromEntries(Object.entries(spec).map(([path, entry]) => [`repo/${path}`, entry])),
    });
    const repoRoot = join(base, "repo");
    const options: StageOptions = {
      source: join(repoRoot, "docs"),
      dest: join(repoRoot, "docs-site", ".docusystem", "site", ".generated", "docs"),
      repoRoot,
      siteDir: join(repoRoot, "docs-site"),
      repoUrl: "https://github.com/Avunu/app",
      branch: "main",
    };
    return { base, repoRoot, options };
  }

  test("a link to a file inside the repository is followed and staged as a regular file", () => {
    const { options } = layout({
      "docs/note.md": { symlink: "../shared/note.md" },
      "docs/guides": { symlink: "../shared" },
    });
    const result = stageDocs(options);
    expect(result.skipped).toEqual([]);
    expect(readFileSync(join(options.dest, "note.md"), "utf8")).toBe("# Shared note\n");
    expect(readFileSync(join(options.dest, "guides", "note.md"), "utf8")).toBe("# Shared note\n");
    expect(lstatSync(join(options.dest, "note.md")).isSymbolicLink()).toBe(false);
    expect(lstatSync(join(options.dest, "guides")).isDirectory()).toBe(true);
  });

  test("a link that leaves the repository is left out and reported with its reason", () => {
    const { base, options } = layout({
      "docs/leak.txt": { symlink: "../../outside/secret.txt" },
      "docs/leaked-folder": { symlink: "../../outside" },
      "docs/absolute.md": { symlink: join("/", "etc", "hostname") },
    });
    // The absolute link may not resolve on this machine: it is skipped either way.
    const result = stageDocs(options);
    expect(result.files).toBe(1);
    expect(existsSync(join(options.dest, "leak.txt"))).toBe(false);
    expect(existsSync(join(options.dest, "leaked-folder"))).toBe(false);
    expect(readTree(options.dest)).toEqual({ "README.md": "# Home\n" });
    expect(result.skipped.map((s) => s.path)).toEqual(["absolute.md", "leak.txt", "leaked-folder"]);
    expect(result.skipped.find((s) => s.path === "leak.txt")!.reason).toBe(
      "a symbolic link outside the repository",
    );
    expect(existsSync(join(base, "outside", "secret.txt"))).toBe(true);
  });

  test("links into .git and node_modules, dangling links and cycles are skipped", () => {
    const { options } = layout({
      "docs/config": { symlink: "../.git/config" },
      "docs/deps": { symlink: "../node_modules" },
      "docs/gone.md": { symlink: "../does-not-exist.md" },
      "docs/loop": { symlink: "." },
      "node_modules/pkg/index.js": "x",
    });
    const result = stageDocs(options);
    expect(Object.fromEntries(result.skipped.map((s) => [s.path, s.reason]))).toEqual({
      config: "a symbolic link into .git",
      deps: "a symbolic link into node_modules",
      "gone.md": "a symbolic link that does not resolve",
      loop: "a symbolic link back to a folder that contains it (a cycle)",
    });
    expect(Object.keys(readTree(options.dest))).toEqual(["README.md"]);
  });

  test("a link inside a dot folder or node_modules is not content, so it is not reported either", () => {
    const { options } = layout({
      "docs/.obsidian/plugin": { symlink: "../../../outside/secret.txt" },
      "docs/node_modules/x": { symlink: "../../../outside/secret.txt" },
    });
    const result = stageDocs(options);
    expect(result.skipped).toEqual([]);
    expect(result.files).toBe(1);
  });

  test("a link in the staging folder is replaced by a regular file, never written through", () => {
    const { base, options } = layout({});
    mkdirSync(options.dest, { recursive: true });
    symlinkSync(join(base, "outside", "secret.txt"), join(options.dest, "README.md"));
    stageDocs(options);
    expect(lstatSync(join(options.dest, "README.md")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(options.dest, "README.md"), "utf8")).toBe("# Home\n");
    expect(readFileSync(join(base, "outside", "secret.txt"), "utf8")).toBe("do not publish");
  });

  test("a staging folder that is itself a link is refused", () => {
    const { base, options } = layout({});
    mkdirSync(join(options.dest, ".."), { recursive: true });
    symlinkSync(join(base, "outside"), options.dest);
    expect(() => stageDocs(options)).toThrow(/symbolic link/);
    expect(existsSync(join(base, "outside", "README.md"))).toBe(false);
  });

  test("the site's own dist/ is not content", () => {
    const { repoRoot } = layout({});
    // docs/ is the whole repository (the Markdown lives at the root): the site folder is inside it.
    writeTree(repoRoot, { "docs-site/dist/index.html": "built", "docs-site/package.json": "{}" });
    const source = repoRoot;
    const dest = join(repoRoot, "docs-site", ".docusystem", "site", ".generated", "docs");
    const result = stageDocs({
      source,
      dest,
      repoRoot,
      siteDir: join(repoRoot, "docs-site"),
      repoUrl: "https://github.com/Avunu/app",
      branch: "main",
    });
    expect(Object.keys(readTree(dest))).not.toContain("docs-site/dist/index.html");
    expect(result.skipped).toEqual([]);
  });
});

test("a read-only file in the staging folder is replaced when its source changes", () => {
  const { root, options } = repo();
  stageDocs(options);
  chmodSync(join(options.dest, "chat.md"), 0o444);
  writeFileSync(join(root, "docs", "chat.md"), "# Changed\n");
  expect(stageDocs(options).written).toBe(1);
  expect(readFileSync(join(options.dest, "chat.md"), "utf8")).toBe("# Changed\n");
});

test("a comment above the frontmatter is moved when the page is staged, and counted", () => {
  const { options } = repo({
    "docs/stamped.md": "<!-- Copyright (c) 2026 -->\n\n---\ntitle: S\n---\n\n# S\n",
  });
  const result = stageDocs(options);
  expect(result.comments).toEqual(["stamped.md"]);
  expect(readFileSync(join(options.dest, "stamped.md"), "utf8")).toBe(
    "---\ntitle: S\n---\n\n<!-- Copyright (c) 2026 -->\n\n# S\n",
  );
});

test("stageSite takes the folders from the paths and the repository from the configuration", () => {
  const root = makeTree({
    "docs/README.md": "# Home\n\nSee [license](../LICENSE) and [chat](docs/chat.md).\n",
    "docs/chat.md": "# Chat\n",
    LICENSE: "MIT",
  });
  const paths = pathsIn(root);
  const config = { repo: "https://github.com/Avunu/docusystem-example" } as DocsConfig;
  const result = stageSite(paths, config, "develop");
  expect(result.files).toBe(2);
  expect(result.links.map((l) => [l.file, l.line, l.from, l.to])).toEqual([
    [
      "README.md",
      3,
      "../LICENSE",
      "https://github.com/Avunu/docusystem-example/blob/develop/LICENSE",
    ],
    ["README.md", 3, "docs/chat.md", "chat.md"],
  ]);
  expect(readFileSync(join(paths.stagedDocs, "README.md"), "utf8")).toContain("[chat](chat.md)");
  // Idempotent: the same call again changes nothing.
  const before = listTree(paths.stagedDocs);
  expect(stageSite(paths, config, "develop")).toMatchObject({ files: 2, written: 0, removed: 0 });
  expect(listTree(paths.stagedDocs)).toEqual(before);
});
