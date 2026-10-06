import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { assemble } from "../../src/lib/assemble.js";
import { jxVersions, packageDir } from "../../src/lib/jx.js";
import { version } from "../../src/lib/package-info.js";
import type { Manifest } from "../../src/lib/types.js";
import { at, listTree, readTree, tempDir, writeTree } from "../support/index.js";
import { CONFIG, SITE_SOURCE, argsFor, copySite, makeShell } from "./helpers.js";

const json = (file: string): Record<string, any> => JSON.parse(readFileSync(file, "utf8"));
const run = (shell: ReturnType<typeof makeShell>, extra = {}) =>
  assemble(argsFor(shell, extra), { siteSource: SITE_SOURCE });

describe("assemble: the root", () => {
  test("holds the package's files, the generated files and links to the Jx packages", async () => {
    const shell = makeShell();
    const result = await run(shell);
    const root = shell.paths.root;

    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.skipped).toEqual([]);
    for (const file of [
      "components/docs-callout.json",
      "components/docs-footer.json",
      "layouts/base.json",
      "layouts/docs.json",
      "pages/index.json",
      "pages/404.json",
      "pages/[...path].json",
      "public/favicon.svg",
      "public/brand/mark.svg",
      "public/.nojekyll",
    ]) {
      expect(readFileSync(at(root, file)), file).toEqual(readFileSync(at(SITE_SOURCE, file)));
    }
    // project.base.json and data/ are not copied: they are generated from.
    expect(existsSync(join(root, "project.base.json"))).toBe(false);

    const project = json(join(root, "project.json"));
    expect(project.name).toBe("Example");
    expect(project.url).toBe("https://example.avunu.net");
    expect(project.$schema).toBeUndefined();
    expect(project.$comment).toBeUndefined();
    expect(project.content.docs.links).toBe("warn");

    expect(json(join(root, "docusystem.config.json"))).toEqual({
      name: "Example",
      tagline: "A sample project for the tests.",
      slug: "example",
      platform: "general",
      repo: "https://github.com/Avunu/docusystem-example",
      domain: "example.avunu.net",
      license: "MIT",
      branch: "main",
      docsPath: "docs",
    });
    expect(readFileSync(join(root, "public", "CNAME"), "utf8")).toBe("example.avunu.net\n");
    expect(readFileSync(join(root, "data", "projects.snapshot.json"))).toEqual(
      readFileSync(at(SITE_SOURCE, "data/projects.snapshot.json")),
    );
    expect(readFileSync(join(shell.paths.work, ".gitignore"), "utf8")).toBe("*\n");

    for (const pkg of ["compiler", "parser", "runtime", "search"]) {
      const link = join(root, "node_modules", "@jxsuite", pkg);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(realpathSync(link)).toBe(packageDir(`@jxsuite/${pkg}`));
    }
  });

  test("writes only real files, except the four links to the Jx packages", async () => {
    const shell = makeShell({
      "docs-site/overrides/components/docs-footer.json": '{"tagName":"docs-footer"}',
      "docs-site/public/og.png": "png",
      "outside.txt": "shared",
    });
    symlinkSync(join(shell.repo, "outside.txt"), join(shell.site, "public", "shared.txt"));
    await run(shell);
    const links = listTree(shell.paths.root).filter((entry) => entry.includes(" -> "));
    expect(links.map((entry) => entry.split(" -> ")[0])).toEqual([
      "node_modules/@jxsuite/compiler",
      "node_modules/@jxsuite/parser",
      "node_modules/@jxsuite/runtime",
      "node_modules/@jxsuite/search",
    ]);
    // A link inside the repository is followed: the published file is a copy of its bytes.
    expect(lstatSync(join(shell.paths.root, "public", "shared.txt")).isFile()).toBe(true);
    expect(readFileSync(join(shell.paths.root, "public", "shared.txt"), "utf8")).toBe("shared");
  });

  test("starts from nothing: nothing of an earlier run survives, the lock does", async () => {
    const shell = makeShell();
    await run(shell);
    writeTree(shell.paths.root, {
      "components/docs-retired.json": "{}",
      "pages/old.json": "{}",
      "public/stale.txt": "x",
    });
    writeTree(shell.paths.work, { lock: "4242\n", "jx.log": "log" });
    writeFileSync(shell.paths.manifest, '{"stale":true}');

    await run(shell);
    for (const file of ["components/docs-retired.json", "pages/old.json", "public/stale.txt"]) {
      expect(existsSync(at(shell.paths.root, file)), file).toBe(false);
    }
    expect(readFileSync(shell.paths.lock, "utf8")).toBe("4242\n");
    expect(json(shell.paths.manifest).stale).toBeUndefined();
  });

  test("is a pure function of its inputs: two runs give byte-identical roots", async () => {
    const shell = makeShell({
      "docs-site/overrides/pages/about.json": '{"title":"About"}',
      "docs-site/public/og.png": "png",
    });
    const first = await run(shell);
    const before = {
      tree: readTree(shell.paths.root),
      manifest: readFileSync(shell.paths.manifest, "utf8"),
    };
    const second = await run(shell);
    expect(readTree(shell.paths.root)).toEqual(before.tree);
    expect(readFileSync(shell.paths.manifest, "utf8")).toBe(before.manifest);
    expect(second.manifest).toEqual(first.manifest);
  });

  test("a docs folder that is the repository root has the docsPath '.'", async () => {
    const shell = makeShell({ "README.md": "# Home\n" });
    shell.paths.docsDir = shell.repo;
    await run(shell);
    expect(json(join(shell.paths.root, "docusystem.config.json")).docsPath).toBe(".");
  });

  test("docsPath is relative to the repository root and /-separated", async () => {
    const shell = makeShell(
      { "documentation/en/README.md": "# Home\n" },
      { docs: "documentation/en" },
    );
    await run(shell);
    expect(json(join(shell.paths.root, "docusystem.config.json")).docsPath).toBe(
      "documentation/en",
    );
  });

  test("writes the branch it was given, not the configured one", async () => {
    const shell = makeShell();
    await run(shell, { branch: "18.0", config: { ...CONFIG, branch: "develop" } });
    expect(json(join(shell.paths.root, "docusystem.config.json")).branch).toBe("18.0");
  });

  test("refuses a site folder whose .docusystem is a symbolic link", async () => {
    const shell = makeShell({ "elsewhere/keep.txt": "keep" });
    symlinkSync(join(shell.repo, "elsewhere"), shell.paths.work);
    await expect(run(shell)).rejects.toThrow(/symbolic link/);
    expect(readFileSync(join(shell.repo, "elsewhere", "keep.txt"), "utf8")).toBe("keep");
  });

  test("a package without a site folder is a broken installation, not a site problem; no stale manifest is left", async () => {
    const shell = makeShell();
    await run(shell);
    expect(existsSync(shell.paths.manifest)).toBe(true);
    await expect(
      assemble(argsFor(shell), { siteSource: join(tempDir(), "missing") }),
    ).rejects.toThrow(/installation is broken/);
    // The manifest of the earlier run describes a root that is gone: it must not outlive it.
    expect(existsSync(shell.paths.manifest)).toBe(false);
    expect(existsSync(join(shell.paths.root, "project.json"))).toBe(false);
  });
});

describe("assemble: a damaged installation of the package", () => {
  test.each(["project.base.json", "data/projects.snapshot.json"])(
    "a package site without %s is an error that says the installation is broken",
    async (file) => {
      const shell = makeShell();
      const site = copySite();
      rmSync(join(site, ...file.split("/")));
      await expect(assemble(argsFor(shell), { siteSource: site })).rejects.toThrow(
        new RegExp(`missing ${file.replace(".", "\\.")}.*installation is broken`),
      );
    },
  );
});

describe("assemble: the manifest", () => {
  test("is the documented one: versions, origin of every file, shadowed, added, catalog, strictness", async () => {
    const shell = makeShell({
      "docs-site/overrides/components/docs-footer.json": '{"tagName":"docs-footer"}',
      "docs-site/overrides/pages/about.json": '{"title":"About"}',
      "docs-site/public/og.png": "png",
      "docs-site/public/favicon.svg": "<svg/>",
    });
    const result = await run(shell, { strict: true });
    const manifest = json(shell.paths.manifest) as Manifest;

    expect(result.manifest).toEqual(manifest);
    expect(Object.keys(manifest)).toEqual([
      "docusystem",
      "runtime",
      "jx",
      "files",
      "shadowed",
      "added",
      "catalog",
      "strict",
    ]);
    expect(manifest.docusystem).toBe(version);
    expect(manifest.runtime).toMatch(/^(node|bun) \d+\.\d+\.\d+/);
    expect(manifest.jx).toEqual(jxVersions());
    expect(Object.keys(manifest.jx)).toEqual([
      "@jxsuite/compiler",
      "@jxsuite/parser",
      "@jxsuite/runtime",
      "@jxsuite/search",
    ]);
    expect(manifest.shadowed).toEqual(["components/docs-footer.json", "public/favicon.svg"]);
    expect(manifest.added).toEqual(["pages/about.json"]);
    expect(result.shadowed).toEqual(manifest.shadowed);
    expect(result.added).toEqual(manifest.added);
    expect(manifest.catalog).toBe("bundled");
    expect(manifest.strict).toBe(true);

    const paths = Object.keys(manifest.files);
    expect(paths).toEqual([...paths].sort());
    expect(manifest.files["components/docs-callout.json"]).toBe("package");
    expect(manifest.files["components/docs-footer.json"]).toBe("override");
    expect(manifest.files["pages/about.json"]).toBe("override");
    expect(manifest.files["public/favicon.svg"]).toBe("override");
    expect(manifest.files["public/og.png"]).toBe("override");
    expect(manifest.files["public/brand/mark.svg"]).toBe("package");
    expect(manifest.files["project.json"]).toBe("generated");
    expect(manifest.files["docusystem.config.json"]).toBe("generated");
    expect(manifest.files["public/CNAME"]).toBe("generated");
    expect(manifest.files["data/projects.snapshot.json"]).toBe("package");
    expect(manifest.files[".generated/nav.json"]).toBe("generated");
    expect(paths.some((p) => p.startsWith("node_modules/") || p.startsWith("dist/"))).toBe(false);
    expect(paths.some((p) => p.startsWith(".generated/docs"))).toBe(false);
    // Every file of the manifest is in the root, except the one that the next pipeline step writes.
    for (const file of paths.filter((p) => p !== ".generated/nav.json")) {
      expect(existsSync(at(shell.paths.root, file)), file).toBe(true);
    }
    // ... and every file of the root (but the Jx links) is in the manifest.
    const inRoot = Object.keys(readTree(shell.paths.root));
    expect(inRoot.filter((p) => !paths.includes(p))).toEqual([]);
  });

  test("records its warnings, and only when there are some", async () => {
    const quiet = makeShell();
    expect(Object.keys((await run(quiet)).manifest)).not.toContain("warnings");

    const noisy = makeShell({ "docs-site/overrides/notes.txt": "x" });
    const result = await run(noisy);
    expect(result.warnings).toHaveLength(1);
    expect(json(noisy.paths.manifest).warnings).toEqual(result.warnings);
  });
});

describe("assemble: overrides and public files", () => {
  test("an override replaces the package's file of the same path and is recorded as shadowing it", async () => {
    const shell = makeShell({
      "docs-site/overrides/components/docs-footer.json": '{"tagName":"docs-footer","$id":"Mine"}',
      "docs-site/overrides/layouts/base.json": '{"tagName":"div"}',
    });
    const result = await run(shell);
    expect(readFileSync(join(shell.paths.root, "components", "docs-footer.json"), "utf8")).toBe(
      '{"tagName":"docs-footer","$id":"Mine"}',
    );
    expect(readFileSync(join(shell.paths.root, "layouts", "base.json"), "utf8")).toBe(
      '{"tagName":"div"}',
    );
    expect(result.shadowed).toEqual(["components/docs-footer.json", "layouts/base.json"]);
    expect(result.added).toEqual([]);
    // The package file next to it is untouched.
    expect(readFileSync(join(shell.paths.root, "components", "docs-callout.json"))).toEqual(
      readFileSync(at(SITE_SOURCE, "components/docs-callout.json")),
    );
  });

  test("a path the package does not ship is added: pages, layouts (nested allowed) and components", async () => {
    const shell = makeShell({
      "docs-site/overrides/pages/about.json": "{}",
      "docs-site/overrides/layouts/extra/wide.json": "{}",
      "docs-site/overrides/components/my-badge.json": "{}",
    });
    const result = await run(shell);
    expect(result.added).toEqual([
      "components/my-badge.json",
      "layouts/extra/wide.json",
      "pages/about.json",
    ]);
    expect(result.shadowed).toEqual([]);
    expect(existsSync(join(shell.paths.root, "layouts", "extra", "wide.json"))).toBe(true);
  });

  test("a nested file in overrides/components is an error and is not copied", async () => {
    const shell = makeShell({
      "docs-site/overrides/components/sub/docs-note.json": "{}",
      "docs-site/overrides/components/docs-footer.json": "{}",
    });
    const result = await run(shell);
    expect(result.errors).toEqual([
      "overrides: overrides/components/sub/docs-note.json is nested: Jx registers only components/*.json, so move it to overrides/components/docs-note.json",
    ]);
    expect(existsSync(join(shell.paths.root, "components", "sub"))).toBe(false);
    expect(result.shadowed).toEqual(["components/docs-footer.json"]);
  });

  test("dotfiles of overrides/ are not Jx files: the eject record and editor litter are skipped", async () => {
    const shell = makeShell({
      "docs-site/overrides/.ejected.json": "{}",
      "docs-site/overrides/components/.DS_Store": "x",
      "docs-site/overrides/pages/.hidden/page.json": "{}",
    });
    const result = await run(shell);
    expect(result.warnings).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.added).toEqual([]);
    expect(existsSync(join(shell.paths.root, "components", ".DS_Store"))).toBe(false);
  });

  test("what is not under components/, layouts/ or pages/ is ignored, with a warning that says what to do instead", async () => {
    const shell = makeShell({
      "docs-site/overrides/project.json": "{}",
      "docs-site/overrides/misc/readme.txt": "x",
      "docs-site/overrides/misc/other.txt": "x",
      "docs-site/overrides/public/logo.svg": "<svg/>",
      "docs-site/overrides/notes.txt": "x",
    });
    const result = await run(shell);
    expect(result.warnings).toEqual([
      "overrides: overrides/misc is ignored: only components/, layouts/ and pages/ are read",
      "overrides: overrides/notes.txt is ignored: only components/, layouts/ and pages/ are read",
      'overrides: overrides/project.json is ignored: the project is changed with the "jx" setting of docusystem.config.json',
      "overrides: overrides/public is ignored: static files go in public/ next to overrides/, not in it",
    ]);
    for (const file of ["misc", "notes.txt", "public/logo.svg"]) {
      expect(existsSync(at(shell.paths.root, file)), file).toBe(false);
    }
    // The generated project is not the override.
    expect(json(join(shell.paths.root, "project.json")).name).toBe("Example");
  });

  test("generated files win over everything else", async () => {
    const shell = makeShell({
      "docs-site/overrides/docusystem.config.json": '{"name":"Hijacked"}',
      "docs-site/public/docusystem.config.json": '{"name":"Hijacked"}',
    });
    await run(shell);
    expect(json(join(shell.paths.root, "docusystem.config.json")).name).toBe("Example");
  });

  test("files of <site>/public win over the package's by name; others are just added", async () => {
    const shell = makeShell({
      "docs-site/public/favicon.svg": "<svg id='mine'/>",
      "docs-site/public/brand/logo.svg": "<svg id='logo'/>",
      "docs-site/public/.well-known/security.txt": "Contact: [PLACEHOLDER]",
      "docs-site/public/.DS_Store": "junk",
    });
    const result = await run(shell);
    const root = shell.paths.root;
    expect(readFileSync(join(root, "public", "favicon.svg"), "utf8")).toBe("<svg id='mine'/>");
    expect(readFileSync(join(root, "public", "brand", "logo.svg"), "utf8")).toBe(
      "<svg id='logo'/>",
    );
    expect(readFileSync(join(root, "public", "brand", "mark.svg"))).toEqual(
      readFileSync(at(SITE_SOURCE, "public/brand/mark.svg")),
    );
    expect(readFileSync(join(root, "public", ".well-known", "security.txt"), "utf8")).toBe(
      "Contact: [PLACEHOLDER]",
    );
    expect(existsSync(join(root, "public", ".DS_Store"))).toBe(false);
    expect(result.shadowed).toEqual(["public/favicon.svg"]);
    expect(result.added).toEqual([]);
  });

  test.each(["CNAME", "cname", "Cname"])(
    "a supplied public/%s is an error: CNAME is generated",
    async (name) => {
      const shell = makeShell({ [`docs-site/public/${name}`]: "evil.example\n" });
      const result = await run(shell);
      expect(result.errors).toEqual([
        "assemble: public/CNAME is not allowed: the file is generated from `domain` in docusystem.config.json, delete it",
      ]);
      expect(readFileSync(join(shell.paths.root, "public", "CNAME"), "utf8")).toBe(
        "example.avunu.net\n",
      );
    },
  );
});

describe("assemble: the symbolic link policy of overrides/ and public/", () => {
  test("links that leave the repository, or lead into .git, are skipped and reported, relative to the site folder", async () => {
    const outside = tempDir();
    writeTree(outside, { "secret.txt": "do not publish" });
    const shell = makeShell({
      "docs-site/overrides/components/docs-footer.json": "{}",
      "docs-site/public/ok.txt": "ok",
    });
    mkdirSync(join(shell.site, "overrides", "pages"), { recursive: true });
    symlinkSync(join(outside, "secret.txt"), join(shell.site, "overrides", "pages", "leak.json"));
    symlinkSync(join(outside, "secret.txt"), join(shell.site, "public", "leak.txt"));
    symlinkSync(join(shell.repo, ".git", "HEAD"), join(shell.site, "public", "head.txt"));
    symlinkSync(join(shell.site, "public", "missing"), join(shell.site, "public", "dangling.txt"));

    const result = await run(shell);
    expect(result.skipped).toEqual([
      { path: "overrides/pages/leak.json", reason: "a symbolic link outside the repository" },
      { path: "public/dangling.txt", reason: "a symbolic link that does not resolve" },
      { path: "public/head.txt", reason: "a symbolic link into .git" },
      { path: "public/leak.txt", reason: "a symbolic link outside the repository" },
    ]);
    expect(result.errors).toEqual([]);
    for (const file of [
      "pages/leak.json",
      "public/leak.txt",
      "public/head.txt",
      "public/dangling.txt",
    ]) {
      expect(existsSync(at(shell.paths.root, file)), file).toBe(false);
    }
    expect(readFileSync(join(shell.paths.root, "public", "ok.txt"), "utf8")).toBe("ok");
    expect(existsSync(join(shell.paths.root, "components", "docs-footer.json"))).toBe(true);
  });

  test("a link back into a folder that contains it (a cycle) and a link into node_modules are skipped, the rest is published", async () => {
    const shell = makeShell({
      "docs-site/public/fonts/a.txt": "a",
      "node_modules/pkg/index.js": "module.exports = 1;",
    });
    symlinkSync(join(shell.site, "public"), join(shell.site, "public", "fonts", "loop"));
    symlinkSync(join(shell.repo, "node_modules", "pkg"), join(shell.site, "public", "pkg"));
    const result = await run(shell);
    expect(result.skipped).toEqual([
      {
        path: "public/fonts/loop",
        reason: "a symbolic link back to a folder that contains it (a cycle)",
      },
      { path: "public/pkg", reason: "a symbolic link into node_modules" },
    ]);
    expect(readFileSync(join(shell.paths.root, "public", "fonts", "a.txt"), "utf8")).toBe("a");
    expect(existsSync(join(shell.paths.root, "public", "pkg"))).toBe(false);
    expect(existsSync(join(shell.paths.root, "public", "fonts", "loop"))).toBe(false);
  });

  test("an overrides folder that is a link out of the repository is an error of the site, and the rest is assembled", async () => {
    const outside = tempDir();
    writeTree(outside, { "components/docs-footer.json": "{}" });
    const shell = makeShell();
    symlinkSync(outside, join(shell.site, "overrides"));
    const result = await run(shell);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/^assemble: overrides\/: .*outside the repository/);
    expect(existsSync(join(shell.paths.root, "project.json"))).toBe(true);
    expect(
      readFileSync(join(shell.paths.root, "components", "docs-footer.json"), "utf8"),
    ).toContain("Package footer");
  });
});

describe("assemble: project.json and the site's settings", () => {
  test("strict makes Jx fail on broken links; lenient only warns", async () => {
    const strict = makeShell();
    await run(strict, { strict: true });
    expect(json(join(strict.paths.root, "project.json")).content.docs.links).toBe("error");
    const lenient = makeShell();
    await run(lenient, { strict: false });
    expect(json(join(lenient.paths.root, "project.json")).content.docs.links).toBe("warn");
  });

  test("theme problems come back as errors with the stage prefix, the rest of the root is written", async () => {
    const shell = makeShell();
    const result = await run(shell, {
      config: { ...CONFIG, theme: { light: { "--color-action": "#4B2A99", "--nope": "1px" } } },
    });
    expect(result.errors).toEqual([
      'assemble: theme.light: "--nope" is not a design token of this version',
    ]);
    const project = json(join(shell.paths.root, "project.json"));
    expect(project.style["--color-action"]).toBe("#4B2A99");
    expect(project.style["--nope"]).toBeUndefined();
  });

  test("images: off and the jx fragment reach project.json; the fragment is announced and its merges are listed", async () => {
    const shell = makeShell();
    const result = await run(shell, {
      config: {
        ...CONFIG,
        images: "off",
        jx: {
          $head: [{ tagName: "meta", attributes: { name: "robots", content: "noindex" } }],
          extensions: ["@jxsuite/parser"],
          build: { trailingSlash: "never" },
        },
      },
    });
    const project = json(join(shell.paths.root, "project.json"));
    expect(project.images).toEqual({ optimize: false });
    expect(project.$head).toHaveLength(3);
    expect(project.$head[2].attributes.name).toBe("robots");
    expect(project.extensions).toEqual(["@jxsuite/parser"]);
    expect(project.build).toEqual({
      outDir: "./dist",
      trailingSlash: "never",
      headers: { enabled: false },
    });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([
      "overrides: jx.extensions replaces 2 entries of the package's list",
      'overrides: the "jx" setting of docusystem.config.json is applied to project.json (unsupported: it does not follow package updates)',
    ]);
    expect(json(shell.paths.manifest).warnings).toEqual(result.warnings);
  });
});
