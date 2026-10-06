import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  findPackageDir,
  JX_PACKAGES,
  jxCli,
  jxVersions,
  linkJxPackages,
  packageDir,
} from "../../src/lib/jx.js";
import { REPO_ROOT, tempDir, writeTree } from "../support/index.js";

const manifest = (dir: string): { name: string; version: string } =>
  JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name: string; version: string };

describe("the Jx packages this package depends on", () => {
  test("are the four of the architecture, exact-pinned in package.json, and installed at the pins", () => {
    const pins = (
      JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
        dependencies: Record<string, string>;
      }
    ).dependencies;
    expect([...JX_PACKAGES]).toEqual([
      "@jxsuite/compiler",
      "@jxsuite/parser",
      "@jxsuite/runtime",
      "@jxsuite/search",
    ]);
    const versions = jxVersions();
    for (const pkg of JX_PACKAGES) {
      expect(pins[pkg], pkg).toMatch(/^\d+\.\d+\.\d+$/); // exact, no range
      expect(versions[pkg], pkg).toBe(pins[pkg]);
    }
  });

  test("packageDir is the real folder of the installed package", () => {
    for (const pkg of JX_PACKAGES) {
      const dir = packageDir(pkg);
      expect(dir).toBe(realpathSync(dir));
      expect(manifest(dir).name).toBe(pkg);
      expect(dir.startsWith(join(REPO_ROOT, "node_modules"))).toBe(true);
    }
  });

  test("jxCli is bin/jx.js of the compiler, which exists", () => {
    expect(jxCli()).toBe(join(packageDir("@jxsuite/compiler"), "bin", "jx.js"));
    expect(existsSync(jxCli())).toBe(true);
  });

  test("a package that is not installed is an error that names it", () => {
    expect(() => packageDir("@jxsuite/not-installed")).toThrow(/@jxsuite\/not-installed/);
  });
});

const pkgFiles = (dir: string, name: string, version: string): Record<string, string> => ({
  [`${dir}/package.json`]: JSON.stringify({ name, version, main: "index.js" }),
  [`${dir}/index.js`]: "module.exports = {};\n",
});

describe("a consumer's own Jx packages are irrelevant", () => {
  test("hoisted: the copy nested next to this package wins over the consumer's different one", () => {
    const consumer = tempDir();
    writeTree(consumer, {
      ...pkgFiles("node_modules/@jxsuite/compiler", "@jxsuite/compiler", "4.0.2"),
      ...pkgFiles("node_modules/@jxsuite/parser", "@jxsuite/parser", "1.8.2"),
      ...pkgFiles(
        "node_modules/@avunu/docusystem/node_modules/@jxsuite/compiler",
        "@jxsuite/compiler",
        "5.0.0",
      ),
      ...pkgFiles(
        "node_modules/@avunu/docusystem/node_modules/@jxsuite/parser",
        "@jxsuite/parser",
        "2.0.0",
      ),
      "node_modules/@avunu/docusystem/dist/lib/jx.js": "",
    });
    const here = join(consumer, "node_modules", "@avunu", "docusystem", "dist", "lib");
    expect(manifest(findPackageDir("@jxsuite/compiler", here)).version).toBe("5.0.0");
    expect(manifest(findPackageDir("@jxsuite/parser", here)).version).toBe("2.0.0");
    // What the consumer's own code would get: the packages the CLI must not use.
    expect(manifest(findPackageDir("@jxsuite/compiler", consumer)).version).toBe("4.0.2");
    expect(manifest(findPackageDir("@jxsuite/parser", consumer)).version).toBe("1.8.2");
  });

  test("hoisted without a different copy of the consumer's: the shared one is found", () => {
    const consumer = tempDir();
    writeTree(consumer, {
      ...pkgFiles("node_modules/@jxsuite/compiler", "@jxsuite/compiler", "5.0.0"),
      "node_modules/@avunu/docusystem/dist/lib/jx.js": "",
    });
    const here = join(consumer, "node_modules", "@avunu", "docusystem", "dist", "lib");
    expect(manifest(findPackageDir("@jxsuite/compiler", here)).version).toBe("5.0.0");
  });

  test("a package whose exports map has no entry for '.' is still found, by the folders Node searches", () => {
    const consumer = tempDir();
    writeTree(consumer, {
      "node_modules/@jxsuite/compiler/package.json": JSON.stringify({
        name: "@jxsuite/compiler",
        version: "9.9.9",
        exports: { "./only-this": "./only-this.js" },
      }),
      "node_modules/@jxsuite/compiler/only-this.js": "",
      "node_modules/@avunu/docusystem/dist/lib/jx.js": "",
    });
    const here = join(consumer, "node_modules", "@avunu", "docusystem", "dist", "lib");
    expect(manifest(findPackageDir("@jxsuite/compiler", here)).version).toBe("9.9.9");
  });

  test("isolated linker: the sibling link of the package's own store folder is followed to its real folder", () => {
    const consumer = tempDir();
    const store = join(consumer, "node_modules", ".store");
    writeTree(consumer, {
      ...pkgFiles(
        "node_modules/.store/jx-compiler/node_modules/@jxsuite/compiler",
        "@jxsuite/compiler",
        "5.0.0",
      ),
      "node_modules/.store/docusystem/node_modules/@avunu/docusystem/dist/lib/jx.js": "",
      ...pkgFiles("node_modules/@jxsuite/compiler", "@jxsuite/compiler", "4.0.2"),
    });
    mkdirSync(join(store, "docusystem", "node_modules", "@jxsuite"), { recursive: true });
    symlinkSync(
      join(store, "jx-compiler", "node_modules", "@jxsuite", "compiler"),
      join(store, "docusystem", "node_modules", "@jxsuite", "compiler"),
    );
    const here = join(store, "docusystem", "node_modules", "@avunu", "docusystem", "dist", "lib");
    const found = findPackageDir("@jxsuite/compiler", here);
    expect(found).toBe(
      realpathSync(join(store, "jx-compiler", "node_modules", "@jxsuite", "compiler")),
    );
    expect(manifest(found).version).toBe("5.0.0");
  });
});

describe("linkJxPackages", () => {
  test("links the four packages by real path and returns their versions", () => {
    const root = tempDir();
    const versions = linkJxPackages(root);
    expect(versions).toEqual(jxVersions());
    for (const pkg of JX_PACKAGES) {
      const link = join(root, "node_modules", ...pkg.split("/"));
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readlinkSync(link)).toBe(packageDir(pkg));
      expect(manifest(link).name).toBe(pkg);
    }
  });

  test("is repeatable, replaces what is in the way and never touches what a link points to", () => {
    const root = tempDir();
    linkJxPackages(root);
    // A stale real folder where a link belongs, and a link that points somewhere else.
    const search = join(root, "node_modules", "@jxsuite", "search");
    const parser = join(root, "node_modules", "@jxsuite", "parser");
    const elsewhere = tempDir();
    writeFileSync(join(elsewhere, "keep.txt"), "keep");
    rmSync(search, { recursive: true, force: true });
    writeTree(search, { "leftover.txt": "x" });
    rmSync(parser, { recursive: true, force: true });
    symlinkSync(elsewhere, parser);

    linkJxPackages(root);
    expect(lstatSync(search).isSymbolicLink()).toBe(true);
    expect(existsSync(join(search, "leftover.txt"))).toBe(false);
    expect(readlinkSync(parser)).toBe(packageDir("@jxsuite/parser"));
    expect(readFileSync(join(elsewhere, "keep.txt"), "utf8")).toBe("keep");
    // The package itself is intact.
    expect(existsSync(join(packageDir("@jxsuite/search"), "package.json"))).toBe(true);
    expect(existsSync(join(packageDir("@jxsuite/parser"), "package.json"))).toBe(true);
  });
});
