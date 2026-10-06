import { expect, test } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { readDocs } from "../../src/lib/docs.js";
import { buildNav, writeNav } from "../../src/lib/nav.js";
import { writeTree } from "../support/index.js";
import { makeTree, pathsIn } from "./helpers.js";

const nav = (files: Record<string, string>, name?: string) =>
  buildNav(readDocs(makeTree(files)), name);

test("order is frontmatter order, then title, with top-level files before folders", () => {
  const { nav: n } = nav({
    "README.md": "# Home\n",
    "zeta.md": "---\ntitle: Zeta\norder: 1\n---\n",
    "alpha.md": "---\ntitle: Alpha\norder: 2\n---\n",
    "beta.md": "# Beta\n",
    "gamma.md": "# Gamma\n",
    "Reference/README.md": "# Reference\n",
    "Reference/api.md": "# API\n",
    "Guides/README.md": "---\ntitle: Guides\norder: 1\n---\n",
    "Guides/b.md": "# Second\n",
    "Guides/a.md": "---\ntitle: First\norder: 1\n---\n",
  });
  expect(n.home).toEqual({ label: "Overview", url: "/docs/" });
  expect(n.loose.map((l) => l.label)).toEqual(["Zeta", "Alpha", "Beta", "Gamma"]);
  expect(n.sections.map((s) => s.label)).toEqual(["Guides", "Reference"]);
  expect(n.sections[0]!.pages.map((p) => p.label)).toEqual(["Overview", "First", "Second"]);
  expect(n.flat.map((f) => f.url)).toEqual([
    "/docs/",
    "/docs/zeta/",
    "/docs/alpha/",
    "/docs/beta/",
    "/docs/gamma/",
    "/docs/guides/",
    "/docs/guides/a/",
    "/docs/guides/b/",
    "/docs/reference/",
    "/docs/reference/api/",
  ]);
});

test("previous and next walk the reading order", () => {
  const { nav: n } = nav({
    "README.md": "# Home\n",
    "a.md": "# A\n",
    "g/README.md": "# G\n",
    "g/b.md": "# B\n",
  });
  expect(n.pages["/docs/"]!.prev).toBeNull();
  expect(n.pages["/docs/"]!.next).toEqual({ title: "A", url: "/docs/a/" });
  expect(n.pages["/docs/a/"]!.next).toEqual({ title: "G", url: "/docs/g/" });
  expect(n.pages["/docs/g/b/"]!.prev).toEqual({ title: "G", url: "/docs/g/" });
  expect(n.pages["/docs/g/b/"]!.next).toBeNull();
});

test("a folder is a section, a folder inside it a group, deeper folders join their group", () => {
  const { nav: n } = nav({
    "README.md": "# Home\n",
    "ops/README.md": "# Operations\n",
    "ops/backup.md": "# Backup\n",
    "ops/cloud/README.md": "# Cloud\n",
    "ops/cloud/aws.md": "# AWS\n",
    "ops/cloud/deep/gcp.md": "# GCP\n",
  });
  const ops = n.sections[0]!;
  expect(ops.label).toBe("Operations");
  expect(ops.url).toBe("/docs/ops/");
  expect(ops.pages.map((p) => p.label)).toEqual(["Overview", "Backup"]);
  expect(ops.groups).toHaveLength(1);
  expect(ops.groups[0]!.label).toBe("Cloud");
  expect(ops.groups[0]!.pages.map((p) => p.url)).toEqual([
    "/docs/ops/cloud/",
    "/docs/ops/cloud/aws/",
    "/docs/ops/cloud/deep/gcp/",
  ]);
  expect(ops.urls).toContain("/docs/ops/cloud/deep/gcp/");
});

test("a folder without a README is named after the folder and has no link of its own", () => {
  const { nav: n } = nav({ "README.md": "# Home\n", "how_to/a.md": "# A\n" });
  expect(n.sections[0]).toMatchObject({ label: "How To", url: null });
});

test("hidden pages are published and reachable but not in the sidebar or previous/next", () => {
  const { nav: n } = nav({
    "README.md": "# Home\n",
    "a.md": "# A\n",
    "secret.md": "---\nhidden: true\n---\n# Secret\n",
    "z.md": "# Z\n",
  });
  expect(n.loose.map((l) => l.label)).toEqual(["A", "Z"]);
  expect(n.flat.map((f) => f.url)).not.toContain("/docs/secret/");
  expect(n.pages["/docs/secret/"]).toMatchObject({ title: "Secret", prev: null, next: null });
  expect(n.pages["/docs/a/"]!.next!.url).toBe("/docs/z/");
});

test("a hidden home page does not shift the landing cards or the open-sections rule", () => {
  const { nav: n } = nav({
    "README.md": "---\nhidden: true\n---\n# Home\n",
    "a.md": "# A\n\nAbout a.\n",
    "b.md": "# B\n",
  });
  expect(n.flat.map((f) => f.url)).toEqual(["/docs/a/", "/docs/b/"]);
  expect(n.featured.map((f) => f.url)).toEqual(["/docs/a/", "/docs/b/"]);
  expect(n.pages["/docs/"]).toMatchObject({ prev: null, next: null });
  const many: Record<string, string> = { "README.md": "---\nhidden: true\n---\n# H\n" };
  for (let i = 0; i < 24; i++) many[`p${String(i).padStart(2, "0")}.md`] = `# P${i}\n`;
  expect(nav(many).nav.expandAll).toBe(true);
  many["p24.md"] = "# P24\n";
  expect(nav(many).nav.expandAll).toBe(false);
});

test("drafts are not in the navigation at all", () => {
  const { nav: n } = nav({ "README.md": "# Home\n", "wip.md": "---\ndraft: true\n---\n# WIP\n" });
  expect(Object.keys(n.pages)).toEqual(["/docs/"]);
});

test("two files with one address publish the first and warn", () => {
  const { nav: n, warnings } = nav({
    "README.md": "# Home\n",
    "Guide.md": "# One\n",
    "guide.md": "# Two\n",
  });
  expect(Object.keys(n.pages).filter((u) => u.includes("guide"))).toEqual(["/docs/guide/"]);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("same address");
});

test("docs/README.md is required", () => {
  expect(() => nav({ "a.md": "# A\n" })).toThrow(/docs\/README\.md is missing/);
});

test("the sidebar starts every section open when the docs are small", () => {
  expect(nav({ "README.md": "# H\n", "a.md": "# A\n" }).nav.expandAll).toBe(true);
  const many: Record<string, string> = { "README.md": "# H\n" };
  for (let i = 0; i < 40; i++) many[`p${i}.md`] = `# P${i}\n`;
  expect(nav(many).nav.expandAll).toBe(false);
});

test("the landing page gets the first pages after the home page, with their descriptions", () => {
  const { nav: n } = nav({
    "README.md": "# H\n",
    "a.md": "# A\n\nAbout a.\n",
    "g/README.md": "# G\n\nAbout g.\n",
  });
  expect(n.featured).toEqual([
    { title: "A", description: "About a.", url: "/docs/a/", section: "" },
    { title: "G", description: "About g.", url: "/docs/g/", section: "G" },
  ]);
});

test("page info carries the title, section, edit path and description", () => {
  const { nav: n } = nav({
    "README.md": "# H\n",
    "g/README.md": "# Guides\n",
    "g/Install Steps.md": "---\ndescription: How.\n---\n# Install\n",
  });
  expect(n.pages["/docs/g/install-steps/"]).toMatchObject({
    title: "Install",
    section: "Guides",
    edit: "g/Install Steps.md",
    description: "How.",
  });
});

test("writeNav reads the staged Markdown and writes the navigation file", () => {
  const root = makeTree({});
  const paths = pathsIn(root);
  writeTree(paths.stagedDocs, { "README.md": "# Home\n\nHello.\n", "a.md": "# A\n" });
  const { pages, nav: written, warnings } = writeNav(paths, { name: "Example" });
  expect(pages).toBe(2);
  expect(warnings).toEqual([]);
  expect(existsSync(paths.navFile)).toBe(true);
  const onDisk = JSON.parse(readFileSync(paths.navFile, "utf8"));
  expect(onDisk).toEqual(written);
  expect(onDisk.home.url).toBe("/docs/");
  expect(onDisk.flat).toHaveLength(2);
  expect(readFileSync(paths.navFile, "utf8")).toBe(`${JSON.stringify(onDisk, null, 2)}\n`);
});

test("writeNav counts the pages Jx will publish: once per address, hidden pages included, drafts not", () => {
  const paths = pathsIn(makeTree({}));
  writeTree(paths.stagedDocs, {
    "README.md": "# Home\n",
    "Guide.md": "# One\n",
    "guide.md": "# Two\n",
    "secret.md": "---\nhidden: true\n---\n# Secret\n",
    "wip.md": "---\ndraft: true\n---\n# WIP\n",
  });
  const { pages, warnings, nav: written } = writeNav(paths, { name: "Example" });
  expect(pages).toBe(3);
  expect(Object.keys(written.pages).sort()).toEqual(["/docs/", "/docs/guide/", "/docs/secret/"]);
  expect(warnings).toHaveLength(1);
  expect(JSON.parse(readFileSync(paths.navFile, "utf8")).pages["/docs/guide/"].title).toBe("One");
});

test("writeNav uses the project name for the home page's title when the page has none", () => {
  const paths = pathsIn(makeTree({}));
  writeTree(paths.stagedDocs, { "README.md": "No heading, just text.\n" });
  expect(writeNav(paths, { name: "frappe-nix" }).nav.pages["/docs/"]!.title).toBe("frappe-nix");
});

test("writeNav without a README says what to add, and writes nothing", () => {
  const paths = pathsIn(makeTree({}));
  writeTree(paths.stagedDocs, { "a.md": "# A\n" });
  expect(() => writeNav(paths, { name: "x" })).toThrow(/docs\/README\.md is missing/);
  expect(existsSync(paths.navFile)).toBe(false);
});

test("a page whose frontmatter is not valid YAML stops the navigation and names the file", () => {
  const paths = pathsIn(makeTree({}));
  writeTree(paths.stagedDocs, { "README.md": "# Home\n", "guides/a.md": "---\na: 1\na: 2\n---\n" });
  expect(() => writeNav(paths, { name: "x" })).toThrow(
    /guides\/a\.md: the frontmatter is not valid YAML/,
  );
});
