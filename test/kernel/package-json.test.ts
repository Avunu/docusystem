// The contract of package.json (section 3.3 of the architecture decision record) that a Dependabot
// bump or a careless edit must not break. Versions are not asserted (the Jx pins move with every
// Jx release); their shape is.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { REPO_ROOT } from "../support/index.js";

interface Pkg {
  type: string;
  bin: Record<string, string>;
  exports: Record<string, unknown>;
  files: string[];
  engines: Record<string, string>;
  publishConfig: Record<string, unknown>;
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  license: string;
}

const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as Pkg;
const EXACT = /^\d+\.\d+\.\d+$/;

describe("package.json", () => {
  test("the runtime dependencies are the four Jx packages and yaml, nothing else, each pinned exactly", () => {
    expect(Object.keys(pkg.dependencies).sort()).toEqual([
      "@jxsuite/compiler",
      "@jxsuite/parser",
      "@jxsuite/runtime",
      "@jxsuite/search",
      "yaml",
    ]);
    for (const [dependency, range] of Object.entries(pkg.dependencies)) {
      expect(range, dependency).toMatch(EXACT);
    }
  });

  test("the development tools are pinned exactly (@types/node follows the Node floor)", () => {
    for (const [dependency, range] of Object.entries(pkg.devDependencies)) {
      if (dependency === "@types/node") expect(range).toMatch(/^\^22\.\d+\.\d+$/);
      else expect(range, dependency).toMatch(EXACT);
    }
    for (const tool of ["oxfmt", "oxlint", "typescript", "vitest", "publint", "ajv"]) {
      expect(pkg.devDependencies, tool).toHaveProperty(tool);
    }
  });

  test("nothing runs when a consumer installs the package", () => {
    for (const hook of ["preinstall", "install", "postinstall", "prepare", "prepublish"]) {
      expect(pkg.scripts, hook).not.toHaveProperty(hook);
    }
    expect(pkg.scripts.prepack).toBe("npm run build");
  });

  test("the surface: one binary, three exports, four shipped folders and files, ESM", () => {
    expect(pkg.type).toBe("module");
    expect(pkg.bin).toEqual({ docusystem: "dist/cli.js" }); // no "./": npm rewrites it and warns
    expect(Object.keys(pkg.exports)).toEqual([".", "./config.schema.json", "./package.json"]);
    expect(pkg.exports["."]).toEqual({ types: "./dist/index.d.ts", default: "./dist/index.js" });
    expect(pkg.files).toEqual(["dist", "site", "scaffold", "config.schema.json"]);
  });

  test("MIT, the Node floor, public access with provenance", () => {
    expect(pkg.license).toBe("MIT");
    expect(pkg.engines).toEqual({ node: ">=22.19.0" });
    expect(pkg.publishConfig).toEqual({ access: "public", provenance: true });
  });

  test("the scripts every pipeline calls exist", () => {
    for (const script of [
      "build",
      "clean",
      "format",
      "format:check",
      "lint",
      "typecheck",
      "test",
      "check",
      "check:pack",
      "check:publint",
      "check:types",
      "test:pack",
      "sync-catalog",
    ]) {
      expect(pkg.scripts, script).toHaveProperty(script);
    }
    expect(pkg.scripts.check).toBe(
      "npm run format:check && npm run lint && npm run typecheck && npm test",
    );
  });
});
