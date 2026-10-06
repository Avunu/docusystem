// An assembled root, built by the real pinned Jx (5.0.0): the acceptance check that what `assemble`
// writes is a project Jx reads as it would a hand-written one. The package's Jx files are the fixture
// `site/` of these tests until WP7's real one lands (see site.test.ts for the same check against it);
// the staged Markdown and the sidebar data, which WP3 writes in the pipeline, are written by hand.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { assemble, type AssembleArgs } from "../../src/lib/assemble.js";
import { jxCli } from "../../src/lib/jx.js";
import { at, readTree, writeTree } from "../support/index.js";
import { SITE_SOURCE, argsFor, makeShell, type Shell } from "./helpers.js";

const NAV = {
  home: { label: "Example", url: "/docs/" },
  loose: [],
  sections: [],
  expandAll: true,
  pages: {},
  flat: [],
  featured: [],
};

/** Assembles `shell` and stages two documents, as the pipeline's steps 4, 5 and 7 would. */
async function prepare(
  shell: Shell,
  extra: Partial<AssembleArgs> = {},
  docs: Record<string, string> = {},
) {
  const result = await assemble(argsFor(shell, extra), { siteSource: SITE_SOURCE });
  writeTree(shell.paths.stagedDocs, {
    "README.md": "---\ntitle: Home\n---\n\nHello.\n\n> [!NOTE]\n> A note.\n",
    "guide/page.md": "---\ntitle: A page\n---\n\nSee [home](../README.md).\n",
    ...docs,
  });
  writeFileSync(shell.paths.navFile, JSON.stringify(NAV));
  return result;
}

/** `jx build <root>` exactly as the pipeline runs it: the CLI of the pinned compiler, root as cwd. */
function jxBuild(root: string) {
  const run = spawnSync(process.execPath, [jxCli(), "build", root], {
    cwd: root,
    encoding: "utf8",
    timeout: 50_000,
  });
  return { status: run.status, output: `${run.stdout}${run.stderr}` };
}

const html = (dist: string, page: string): string => readFileSync(join(dist, page), "utf8");

describe("an assembled root, built by the real pinned Jx", () => {
  test("builds: Done: N routes, the pages, the generated files and the pre-rendered components", async () => {
    const shell = makeShell();
    await prepare(shell);
    const build = jxBuild(shell.paths.root);
    expect(build.output).toMatch(/^Done: 4 routes/m); // / and /404/ of the package + the two documents
    expect(build.status).toBe(0);

    const dist = shell.paths.jxDist;
    for (const file of [
      "index.html",
      "404/index.html",
      "docs/index.html",
      "docs/guide/page/index.html",
      "favicon.svg",
      "brand/mark.svg",
      ".nojekyll",
      "CNAME",
      "search-index.json",
      "sitemap.xml",
    ]) {
      expect(existsSync(at(dist, file)), file).toBe(true);
    }
    expect(readFileSync(join(dist, "CNAME"), "utf8")).toBe("example.avunu.net\n");

    const home = html(dist, "index.html");
    expect(home).toContain("<h1>Example</h1>"); // docusystem.config.json reached the page
    expect(home).toContain("A sample project for the tests.");
    expect(home).toContain("<docs-footer data-jx-static><p>Package footer</p></docs-footer>");
    // The tokens of the generated project.json reached the stylesheet, light and dark.
    expect(home).toContain("--color-action: #6237BF");
    expect(home).toContain("--color-action: #CBB8FF");
    // The documents were rendered through the docs content type, alerts through the registered component.
    expect(html(dist, "docs/index.html")).toContain(
      '<docs-callout data-alert="note" data-jx-static>',
    );
    expect(html(dist, "docs/guide/page/index.html")).toContain('href="/docs/"');
  });

  test("the identity and the theme of the configuration are in the built site", async () => {
    const shell = makeShell();
    await prepare(shell, {
      config: {
        name: "Frappe Nix",
        tagline: "Reproducible Nix infrastructure.",
        slug: "frappe-nix",
        platform: "nixos",
        repo: "https://github.com/Avunu/frappe-nix",
        domain: "frappe-nix.avunu.net",
        license: "MIT",
        theme: { light: { "--color-action": "#4B2A99" }, dark: { "--color-action": "#DDD0FF" } },
      },
    });
    expect(jxBuild(shell.paths.root).status).toBe(0);
    const home = html(shell.paths.jxDist, "index.html");
    expect(home).toContain("<h1>Frappe Nix</h1>");
    expect(home).toContain("--color-action: #4B2A99");
    expect(home).toContain("--color-action: #DDD0FF");
    expect(home).not.toContain("#6237BF");
    expect(readFileSync(join(shell.paths.jxDist, "CNAME"), "utf8")).toBe("frappe-nix.avunu.net\n");
    expect(readFileSync(join(shell.paths.jxDist, "sitemap.xml"), "utf8")).toContain(
      "https://frappe-nix.avunu.net/",
    );
  });

  test("overrides are what is built: a replaced component, an added page, a replaced static file", async () => {
    const shell = makeShell({
      "docs-site/overrides/components/docs-footer.json": JSON.stringify({
        $id: "DocsFooter",
        tagName: "docs-footer",
        children: [{ tagName: "p", textContent: "Override footer" }],
      }),
      "docs-site/overrides/pages/about.json": JSON.stringify({
        $layout: "./layouts/base.json",
        title: "About",
        children: [{ tagName: "main", children: [{ tagName: "h1", textContent: "About us" }] }],
      }),
      "docs-site/public/favicon.svg": "<svg xmlns='http://www.w3.org/2000/svg' id='mine'/>",
    });
    const result = await prepare(shell);
    expect(result.shadowed).toEqual(["components/docs-footer.json", "public/favicon.svg"]);
    expect(result.added).toEqual(["pages/about.json"]);

    const build = jxBuild(shell.paths.root);
    expect(build.output).toMatch(/^Done: 5 routes/m);
    expect(build.status).toBe(0);
    const dist = shell.paths.jxDist;
    expect(html(dist, "index.html")).toContain("Override footer");
    expect(html(dist, "index.html")).not.toContain("Package footer");
    expect(html(dist, "about/index.html")).toContain("About us");
    expect(readFileSync(join(dist, "favicon.svg"), "utf8")).toContain("id='mine'");
  });

  test("a strict assembly makes Jx itself fail on a broken link; a lenient one only warns", async () => {
    const broken = { "guide/page.md": "---\ntitle: A page\n---\n\nSee [nowhere](./missing.md).\n" };

    const strict = makeShell();
    await prepare(strict, { strict: true }, broken);
    const failed = jxBuild(strict.paths.root);
    expect(failed.status).not.toBe(0);
    expect(failed.output).toMatch(/broken link/i);

    const lenient = makeShell();
    await prepare(lenient, { strict: false }, broken);
    const warned = jxBuild(lenient.paths.root);
    expect(warned.status).toBe(0);
    expect(warned.output).toMatch(/^Content links: .*"\.\/missing\.md", which does not exist/m);
    expect(warned.output).toMatch(/^Done: 4 routes/m);
  });

  test("a clean strict assembly builds with no problem line", async () => {
    const shell = makeShell();
    await prepare(shell, { strict: true });
    const build = jxBuild(shell.paths.root);
    expect(build.status).toBe(0);
    expect(
      build.output.split("\n").filter((line) => /^(?:Content\b|Warning:|Error)/.test(line)),
    ).toEqual([]);
  });

  test("building the same root again gives the same bytes", async () => {
    const shell = makeShell();
    await prepare(shell);
    const first = jxBuild(shell.paths.root);
    expect(first.status).toBe(0);
    const before = readTree(shell.paths.jxDist);
    // Build again over the existing dist: same bytes.
    const second = jxBuild(shell.paths.root);
    expect(second.status).toBe(0);
    expect(readTree(shell.paths.jxDist)).toEqual(before);
  });
});
