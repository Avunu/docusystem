import { spawnSync } from "node:child_process";
import { readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { REPO_ROOT, tempDir, writeTree } from "../support/index.js";
import { canonical, generator, sha256, type Canonical, type Generator } from "./support.js";

// scripts/legacy: the canonical form that recognizes a starter JSON file whatever its formatting, and the
// generator of starter-v0.json from a clone of the starter's commit.

let c: Canonical;
let g: Generator;

beforeAll(async () => {
  c = await canonical();
  g = await generator();
});

const COMMIT = "1820d01ccbd2a6a299f6f673381a2272a06c64dc";
const SCRIPT = join(REPO_ROOT, "scripts", "legacy", "generate-starter-v0.mjs");

describe("canonical form", () => {
  test("does not depend on the order of keys at any level, nor on formatting", () => {
    const a = { b: 1, a: { y: [1, 2], x: "s" } };
    const b = JSON.parse('{ "a": { "x": "s",\n "y": [1,\n 2] }, "b": 1 }') as unknown;
    expect(c.canonicalSha256(a)).toBe(c.canonicalSha256(b));
  });

  test("does depend on values and on the order of an array", () => {
    expect(c.canonicalSha256({ a: [1, 2] })).not.toBe(c.canonicalSha256({ a: [2, 1] }));
    expect(c.canonicalSha256({ a: 1 })).not.toBe(c.canonicalSha256({ a: 2 }));
  });

  test("leaves out the named top-level keys, and only those", () => {
    const withName = { name: "x", url: "u", rest: { name: "kept" } };
    expect(c.canonicalSha256(withName, ["name", "url"])).toBe(
      c.canonicalSha256({ name: "other", url: "v", rest: { name: "kept" } }, ["name", "url"]),
    );
    expect(c.canonicalSha256(withName, ["name"])).not.toBe(c.canonicalSha256(withName, ["url"]));
    expect(c.canonicalSha256({ rest: { name: "kept" } })).toBe(
      c.canonicalSha256(withName, ["name", "url"]),
    );
    expect(c.canonicalSha256({ rest: { name: "changed" } })).not.toBe(
      c.canonicalSha256(withName, ["name", "url"]),
    );
  });

  test("hashes only objects", () => {
    expect(() => c.canonicalSha256([1])).toThrow("expected a JSON object");
    expect(() => c.canonicalSha256("x")).toThrow("expected a JSON object");
    expect(() => c.canonicalSha256(null)).toThrow("expected a JSON object");
  });
});

/** A template folder as small as the generator accepts. */
const TEMPLATE = {
  "docs.config.json": '{ "name": "Project Name" }\n',
  ".github/workflows/docs.yml": "name: Docs\n",
  ".github/dependabot.yml": "version: 2\n",
  "scripts/lib/stage.ts": "export {};\n",
  "package.json": '{ "name": "project-name-docs", "private": true }\n',
  "project.json": '{ "name": "Project Name", "url": "https://x", "defaults": {} }\n',
  "public/fonts/f.woff2": "binary",
};

describe("the generator", () => {
  test("hashes every file of the template, sorted, and records the commit", () => {
    const dir = writeTree(tempDir("docusystem-template-"), TEMPLATE);
    const out = g.describeStarter(dir, COMMIT);
    expect(Object.keys(out.files)).toEqual([
      ".github/dependabot.yml",
      ".github/workflows/docs.yml",
      "docs.config.json",
      "package.json",
      "project.json",
      "public/fonts/f.woff2",
      "scripts/lib/stage.ts",
    ]);
    expect(out.files["public/fonts/f.woff2"]).toBe(sha256("binary"));
    expect(out.source).toEqual({
      repository: "Avunu/docs",
      branch: "feat/project-docs-starter",
      path: "Sites/project-docs-starter/template",
      commit: COMMIT,
    });
    expect(out.canonical["package.json"]).toEqual({
      ignore: ["name"],
      sha256: c.canonicalSha256({ private: true }),
    });
    expect(out.canonical["project.json"]).toEqual({
      ignore: ["name", "url"],
      sha256: c.canonicalSha256({ defaults: {} }),
    });
    expect(out.note).toContain("Paths under .github/ belong to the repository root");
  });

  test("a folder that is not the template, or has a link in it, is refused", () => {
    const missing = writeTree(tempDir("docusystem-template-"), { "README.md": "x\n" });
    expect(() => g.describeStarter(missing, COMMIT)).toThrow("is this the template folder");
    const linked = writeTree(tempDir("docusystem-template-"), TEMPLATE);
    symlinkSync(join(linked, "docs.config.json"), join(linked, "link.json"));
    expect(() => g.describeStarter(linked, COMMIT)).toThrow("link.json is a symbolic link");
  });

  test("an installed or built folder at the top is not part of the template", () => {
    const dir = writeTree(tempDir("docusystem-template-"), {
      ...TEMPLATE,
      "node_modules/x/index.js": "x",
      "dist/index.html": "x",
    });
    expect(g.listFiles(dir)).not.toContain("node_modules/x/index.js");
    expect(g.listFiles(dir)).not.toContain("dist/index.html");
  });

  test("the command writes the file, --check compares, and usage errors exit 2", () => {
    const dir = writeTree(tempDir("docusystem-template-"), TEMPLATE);
    const out = join(tempDir("docusystem-out-"), "starter-v0.json");
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
    const wrote = run(dir, "--commit", COMMIT, "--out", out);
    expect(wrote.status).toBe(0);
    expect(wrote.stdout).toContain("wrote 7 hashes");
    expect(JSON.parse(readFileSync(out, "utf8")).source.commit).toBe(COMMIT);
    expect(readFileSync(out, "utf8").endsWith("}\n")).toBe(true);

    expect(run(dir, "--commit", COMMIT, "--out", out, "--check").status).toBe(0);
    writeTree(dir, { "README.md": "a new file\n" });
    const stale = run(dir, "--commit", COMMIT, "--out", out, "--check");
    expect(stale.status).toBe(1);
    expect(stale.stderr).toContain("differs from the template");

    expect(run(dir).status).toBe(2);
    expect(run(dir, "--commit", "abc").status).toBe(2);
    expect(run("--commit", COMMIT).status).toBe(2);
    expect(run("--help").status).toBe(0);
  });
});
