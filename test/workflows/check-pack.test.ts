// scripts/check-pack.mjs: the allowlist, the required files and the budget of the published tarball
// (section 3.4 of the architecture decision record), tested on file lists (the rules) and on small
// real packages packed with `npm pack --dry-run` (the command line).
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  ALLOWED,
  BUDGET,
  FORBIDDEN,
  INSTALL_HOOKS,
  REQUIRED,
  problemsWith,
} from "../../scripts/check-pack.mjs";
import { REPO_ROOT, tempDir } from "../support/index.js";
import { readJson } from "./helpers.js";

const GOOD = [
  ...REQUIRED,
  "CHANGELOG.md",
  "dist/lib/config.js",
  "dist/lib/config.d.ts",
  "site/components/docs-footer.json",
  "site/public/fonts/figtree.woff2",
  "scaffold/.hidden-ok",
];
const SIZES = { size: 200 * 1024, unpackedSize: 600 * 1024 };

describe("check-pack rules", () => {
  test("a complete, small tarball passes", () => {
    expect(problemsWith({ paths: GOOD, ...SIZES })).toEqual([]);
  });

  test("the budget is the record's 400 KB packed and 1.2 MB unpacked, and 200 files (the record's 120 cannot hold the layout of dist/)", () => {
    expect(BUDGET).toEqual({ packed: 400 * 1024, unpacked: 1_200 * 1024, files: 200 });
    expect(
      problemsWith({ paths: GOOD, size: BUDGET.packed, unpackedSize: BUDGET.unpacked }),
    ).toEqual([]);
    expect(problemsWith({ paths: GOOD, size: BUDGET.packed + 1, unpackedSize: 1 })).toEqual([
      `tarball is ${BUDGET.packed + 1} bytes, over the ${BUDGET.packed} budget`,
    ]);
    expect(problemsWith({ paths: GOOD, size: 1, unpackedSize: BUDGET.unpacked + 1 })).toEqual([
      `unpacked size is ${BUDGET.unpacked + 1} bytes, over the ${BUDGET.unpacked} budget`,
    ]);
    const many = [...GOOD];
    for (let i = 0; many.length <= BUDGET.files; i += 1) many.push(`site/extra/${i}.json`);
    expect(problemsWith({ paths: many, ...SIZES })).toEqual([
      `${many.length} files, over the ${BUDGET.files} budget`,
    ]);
  });

  test("names every required file that is missing", () => {
    for (const path of REQUIRED) {
      const without = GOOD.filter((candidate) => candidate !== path);
      expect(problemsWith({ paths: without, ...SIZES }), path).toEqual([
        `missing from the tarball: ${path}`,
      ]);
    }
  });

  test("requires what section 3.4 requires: the entry points, the base project, the font licence, the catalog, the five scaffold files", () => {
    for (const path of [
      "dist/cli.js",
      "dist/index.js",
      "dist/index.d.ts",
      "site/project.base.json",
      "site/layouts/base.json",
      "site/public/fonts/LICENSE-Figtree.txt",
      "site/data/projects.snapshot.json",
      "scaffold/docs.yml",
      "scaffold/docs-publish.yml",
      "scaffold/dependabot-npm.yml",
      "scaffold/dependabot-actions.yml",
      "scaffold/gitignore",
    ]) {
      expect(REQUIRED, path).toContain(path);
    }
  });

  test.each([
    ["a test file", "dist/lib/config.test.js"],
    ["a spec file", "dist/lib/config.spec.ts"],
    ["a source map", "dist/cli.js.map"],
    ["a declaration map", "dist/index.d.ts.map"],
    ["a source file", "src/main.ts"],
    ["a build info file", "dist/.tsbuildinfo"],
    ["an environment file", "site/.env.local"],
    ["a tarball", "docusystem-0.1.0.tgz"],
    ["a nested node_modules", "site/node_modules/x/index.js"],
    ["a Bun lockfile", "site/bun.lock"],
    ["a workflow-ref.json", "site/workflow-ref.json"],
    ["a legacy folder", "site/legacy/starter-v0.json"],
    ["a test folder", "site/__tests__/a.json"],
    ["a script", "scripts/check-pack.mjs"],
    ["a second level in scaffold", "scaffold/nested/docs.yml"],
  ])("refuses %s", (_what, path) => {
    const problems = problemsWith({ paths: [...GOOD, path], ...SIZES });
    expect(problems.length, path).toBeGreaterThan(0);
    expect(
      problems.some((problem) => problem.endsWith(path)),
      path,
    ).toBe(true);
  });

  test("forbidden files are named as forbidden even where the allowlist lets them in", () => {
    // Both match an allowed pattern (site/** and dist/**/*.js), so the forbidden rule is the only one that fires.
    expect(
      problemsWith({ paths: [...GOOD, "site/data/x.map", "dist/lib/a.test.js"], ...SIZES }),
    ).toEqual([
      "forbidden file in the tarball: site/data/x.map",
      "forbidden file in the tarball: dist/lib/a.test.js",
    ]);
  });

  test.each(INSTALL_HOOKS)(
    "refuses a %s script: nothing may run when a consumer installs the package",
    (hook) => {
      expect(problemsWith({ paths: GOOD, ...SIZES, scripts: { [hook]: "node x.js" } })).toEqual([
        `package.json has a "${hook}" script: nothing may run at install time`,
      ]);
    },
  );

  test("allows prepack, which only builds for publishing", () => {
    expect(
      problemsWith({
        paths: GOOD,
        ...SIZES,
        scripts: { prepack: "npm run build", test: "vitest run" },
      }),
    ).toEqual([]);
  });

  test("the allowlist matches every folder package.json ships, and the lists are non-empty", () => {
    const { files } = readJson<{ files: string[] }>("package.json");
    for (const entry of files) {
      const sample = entry.includes(".") ? entry : `${entry}/file.json`;
      const covered =
        ALLOWED.some((pattern) => pattern.test(sample)) ||
        ALLOWED.some((pattern) => pattern.test(`${entry}/x.js`)) ||
        ALLOWED.some((pattern) => pattern.test(`${entry}/x.yml`));
      expect(covered, entry).toBe(true);
    }
    expect(ALLOWED.length).toBeGreaterThan(0);
    expect(FORBIDDEN.length).toBeGreaterThan(0);
  });
});

// npm is a shell script on Windows, which is unsupported: the rules above run everywhere, the command here does not.
describe.skipIf(process.platform === "win32")(
  "check-pack as a command, on small real packages",
  () => {
    /** A package folder with the given files, each holding one line. */
    function pack(files: string[], manifest: Record<string, unknown> = {}): string {
      const root = tempDir();
      const pkg = {
        name: "@avunu/docusystem-fixture",
        version: "0.0.1",
        files: ["dist", "site", "scaffold", "config.schema.json"],
        ...manifest,
      };
      writeFileSync(join(root, "package.json"), JSON.stringify(pkg));
      for (const file of files) {
        mkdirSync(dirname(join(root, file)), { recursive: true });
        writeFileSync(join(root, file), "x\n");
      }
      return root;
    }
    const run = (cwd: string) =>
      spawnSync(process.execPath, [join(REPO_ROOT, "scripts", "check-pack.mjs")], {
        cwd,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: cwd,
          npm_config_update_notifier: "false",
          npm_config_fund: "false",
          npm_config_audit: "false",
        },
        encoding: "utf8",
      });

    test("passes a package that has everything and nothing else, and prints what it packed", () => {
      const result = run(
        pack([...REQUIRED.filter((path) => path !== "package.json"), "dist/lib/x.d.ts"]),
      );
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(
        /^@avunu\/docusystem-fixture@0\.0\.1: \d+ files, \d+ bytes packed, \d+ unpacked$/m,
      );
    });

    test("fails a package with a source map, a test, and a postinstall script, saying each", () => {
      const result = run(
        pack(
          [
            ...REQUIRED.filter((path) => path !== "package.json"),
            "dist/cli.js.map",
            "dist/x.test.js",
          ],
          {
            scripts: { postinstall: "node x.js" },
          },
        ),
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("check-pack: forbidden file in the tarball: dist/cli.js.map");
      expect(result.stderr).toContain("check-pack: forbidden file in the tarball: dist/x.test.js");
      expect(result.stderr).toContain('check-pack: package.json has a "postinstall" script');
    });

    test("fails an empty package listing what is missing", () => {
      const result = run(pack([]));
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("check-pack: missing from the tarball: dist/cli.js");
      expect(result.stderr).toContain("check-pack: missing from the tarball: scaffold/gitignore");
    });
  },
);
