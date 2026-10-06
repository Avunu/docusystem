import { expect, test } from "vitest";
import { join } from "node:path";
import { writeTree } from "../support/index.js";
import { makeTree } from "./helpers.js";
import { githubUrl, repoTarget, rewriteRepoLinks } from "../../src/lib/repo-links.js";

function setup() {
  const repo = makeTree({
    "README.md": "x",
    LICENSE: "x",
    "lib/a.nix": "x",
    "lib/deep/b.py": "x",
    "assets/logo.png": "x",
    "docs/guides/setup.md": "x",
    "docs/guides/example.json": "{}",
    "docs-site/dist/docs/index.html": "x",
    "docs-site/dist/docs/guides/setup/index.html": "x",
  });
  return {
    repo,
    options: {
      dist: join(repo, "docs-site", "dist"),
      repoRoot: repo,
      docsDir: join(repo, "docs"),
      repoUrl: "https://github.com/Avunu/x",
      branch: "main",
    },
  };
}

test("a link finds its file next to the document first, then at the repository root", () => {
  const { options } = setup();
  expect(repoTarget("example.json", "guides", options)).toBe("docs/guides/example.json");
  expect(repoTarget("lib/a.nix", "", options)).toBe("lib/a.nix");
  expect(repoTarget("../../lib/deep/b.py", "guides", options)).toBe("lib/deep/b.py");
  expect(repoTarget("LICENSE", "guides", options)).toBe("LICENSE");
  expect(repoTarget("missing.txt", "", options)).toBeNull();
  expect(repoTarget("../../../outside", "guides", options)).toBeNull();
});

test("absolute, external and fragment-only links are never repository links", () => {
  const { options } = setup();
  for (const href of ["/lib/a.nix", "https://example.com/x", "mailto:a@b.c", "#top", "", "//cdn/x"])
    expect(repoTarget(href, "", options)).toBeNull();
});

test("GitHub addresses: blob for files, tree for folders, raw for images", () => {
  const { options } = setup();
  expect(githubUrl(options, "lib/a.nix", false)).toBe(
    "https://github.com/Avunu/x/blob/main/lib/a.nix",
  );
  expect(githubUrl(options, "lib", false)).toBe("https://github.com/Avunu/x/tree/main/lib");
  expect(githubUrl(options, "assets/logo.png", true)).toBe(
    "https://github.com/Avunu/x/raw/main/assets/logo.png",
  );
  expect(githubUrl(options, "docs/guides", false)).toBe(
    "https://github.com/Avunu/x/tree/main/docs/guides",
  );
});

test("a link that is already a built page is left alone, a repository file is rewritten", () => {
  const { options } = setup();
  const html =
    '<p><a href="guides/setup/">page</a> <a href="lib/a.nix">code</a> <a href="lib/">folder</a> <img src="assets/logo.png" alt=""> <a href="https://x.dev/">ext</a> <a href="nope">nope</a></p>';
  const { html: out, links } = rewriteRepoLinks(html, "/docs/", "", options);
  expect(out).toContain('href="guides/setup/"');
  expect(out).toContain('href="https://github.com/Avunu/x/blob/main/lib/a.nix"');
  expect(out).toContain('href="https://github.com/Avunu/x/tree/main/lib"');
  expect(out).toContain('src="https://github.com/Avunu/x/raw/main/assets/logo.png"');
  expect(out).toContain('href="nope"');
  expect(links.map((l) => l.from)).toEqual(["lib/a.nix", "lib/", "assets/logo.png"]);
});

test("a fragment survives the rewrite", () => {
  const { options } = setup();
  const { html } = rewriteRepoLinks('<a href="lib/a.nix#L10">x</a>', "/docs/", "", options);
  expect(html).toContain("/blob/main/lib/a.nix#L10");
});

test("a fragment or a title with $ in it is kept as written", () => {
  const { options } = setup();
  const { html, links } = rewriteRepoLinks(
    '<a class="x" href="lib/a.nix#L$&$1">x</a>',
    "/docs/",
    "",
    options,
  );
  expect(html).toBe(
    '<a class="x" href="https://github.com/Avunu/x/blob/main/lib/a.nix#L$&amp;$1">x</a>',
  );
  expect(links).toHaveLength(1);
});

test("a link that climbs out of the site, and one with an address, are left alone", () => {
  const { options } = setup();
  const html =
    '<a href="../../../../../../etc/passwd">a</a> <a href="/lib/a.nix">b</a> <a href="#x">c</a> <a href="mailto:a@b.c">d</a>';
  expect(rewriteRepoLinks(html, "/docs/", "", options)).toEqual({ html, links: [] });
});

test("a page that sits in a folder of docs/ finds repository files next to its Markdown first", () => {
  const { options } = setup();
  const { html, links } = rewriteRepoLinks(
    '<a href="example.json">json</a>',
    "/docs/guides/setup/",
    "guides",
    options,
  );
  expect(html).toContain('href="https://github.com/Avunu/x/blob/main/docs/guides/example.json"');
  expect(links[0]).toEqual({
    page: "/docs/guides/setup/",
    from: "example.json",
    to: "https://github.com/Avunu/x/blob/main/docs/guides/example.json",
  });
});

test("an image or link already built into dist is not rewritten, whatever the repository holds", () => {
  const { repo, options } = setup();
  writeTree(repo, { "docs-site/dist/docs/img/flow.png": "png", "docs/img/flow.png": "png" });
  const html = '<img src="../img/flow.png" alt=""> <a href="../guides/setup/">s</a>';
  expect(rewriteRepoLinks(html, "/docs/other/", "other", options).links).toEqual([]);
});

test("a branch with a slash and a path with spaces and parentheses are written as GitHub reads them", () => {
  const { repo, options } = setup();
  writeTree(repo, { "My Notes/a (1).md": "x" });
  expect(githubUrl({ ...options, branch: "release/1.0" }, "My Notes/a (1).md", false)).toBe(
    "https://github.com/Avunu/x/blob/release/1.0/My%20Notes/a%20(1).md",
  );
  expect(githubUrl(options, "", false)).toBe("https://github.com/Avunu/x/tree/main");
});
