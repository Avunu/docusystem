// The canary through the REAL modules (section 9.2 of the architecture record): the commands of the
// command line on a clean and a broken tree, with the real configuration, assembly, staging, lint, nav,
// post-processing, assertions, link crawl, contrast gate and site files, and the real pinned Jx.
//
// This file is written in the work package that owns the commands (WP5), where the other packages were
// stubs. It therefore skips itself, visibly, until every module it needs is implemented, and runs for
// real after the packages are merged. jx-canary.test.ts runs the same trees through the real pipeline
// and the real Jx with stand-ins for those packages, and always runs.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { run } from "../../src/main.js";
import { validateConfig } from "../../src/lib/config.js";
import { readBundledCatalog, readBundledCatalogDocument } from "../../src/lib/catalog.js";
import { contrastFailures } from "../../src/lib/contrast.js";
import { jxVersions } from "../../src/lib/jx.js";
import { lintDocs } from "../../src/lib/lint.js";
import { acquireLock } from "../../src/lib/lock.js";
import { json, serve } from "../config/server.js";
import { REPO_ROOT, listTree, runCli, tempDir } from "../support/index.js";
import { jxEnv, repoFrom, type Repo } from "./support.js";

// ---- is everything this file needs implemented? ----

/** The stubs of the work packages throw `not implemented (WPn)`; a probe is missing when it does. */
function missing(wp: string, probe: () => unknown): string[] {
  try {
    probe();
    return [];
  } catch (error) {
    return new RegExp(`^not implemented \\(${wp}\\)`).test((error as Error).message) ? [wp] : [];
  }
}

const absent = [
  ...missing("WP1", () => validateConfig({})),
  ...missing("WP1", () => readBundledCatalog()),
  ...missing("WP2", () => jxVersions()),
  ...missing("WP2", () => acquireLock({ work: tempDir(), lock: join(tempDir(), "lock") })()),
  ...missing("WP3", () => lintDocs(tempDir())),
  ...missing("WP4", () => contrastFailures({}, null)),
  ...(existsSync(join(REPO_ROOT, "site", "project.base.json")) ? [] : ["WP7"]),
];
const waiting = [...new Set(absent)];

// ---- helpers ----

/** Runs the command line in `repo`'s site folder, as CI does for `check` (a clean environment, CI=true). */
function cli(repo: Repo, argv: string[], env: NodeJS.ProcessEnv = {}) {
  return runCli(argv, { cwd: repo.siteDir, env: jxEnv({ CI: "true", ...env }) });
}

const occurrences = (text: string, needle: string): number => text.split(needle).length - 1;

const cleanRepo = (): Repo => repoFrom("canary/clean");

describe.skipIf(waiting.length > 0)(
  waiting.length === 0
    ? "the canary through the real modules"
    : `the canary through the real modules (skipped until merged: ${waiting.join(", ")})`,
  () => {
    describe("a clean tree", () => {
      test("build writes <site>/dist, prints the manual jx command and exits 0", async () => {
        const repo = cleanRepo();
        const { code, stdout, stderr } = await cli(repo, ["build"]);
        expect(code, `${stdout}\n${stderr}`).toBe(0);
        expect(stdout).toMatch(/^build: \d+ page\(s\) written to /m);
        expect(stdout).toMatch(/^build: to run Jx by hand on the assembled project: /m);
        for (const file of ["index.html", "404.html", "CNAME", ".nojekyll", "sitemap.xml"]) {
          expect(existsSync(join(repo.paths.dist, file)), file).toBe(true);
        }
        expect(existsSync(join(repo.paths.dist, "404"))).toBe(false);
        expect(readFileSync(join(repo.paths.dist, "CNAME"), "utf8").trim()).toBe(
          "docusystem-example.avunu.net",
        );
        expect(readFileSync(repo.paths.jxLog, "utf8")).toMatch(/^Done: \d+ routes/m);
        // the build wrote everything it writes under .docusystem/ and dist/, nothing else
        expect(listTree(repo.siteDir).filter((p) => !/^(\.docusystem|dist)(\/|$)/.test(p))).toEqual(
          ["docusystem.config.json"],
        );
      });

      test("check passes: strict build, contrast, links; with --ci a summary and the outputs", async () => {
        const repo = cleanRepo();
        const files = tempDir();
        const summary = join(files, "summary.md");
        const output = join(files, "output");
        const { code, stdout, stderr } = await cli(repo, ["check", "--ci"], {
          GITHUB_STEP_SUMMARY: summary,
          GITHUB_OUTPUT: output,
        });
        expect(code, `${stdout}\n${stderr}`).toBe(0);
        expect(stdout).toMatch(/^contrast: \d+ color pair\(s\) checked, 0 below the minimum$/m);
        expect(stdout).toMatch(/^links: \d+ page\(s\), \d+ reference\(s\) checked$/m);
        expect(stdout.split("\n").at(-1)).toBe("check: all steps passed");
        expect(stdout.split("\n").filter((line) => line.startsWith("::"))).toEqual([]);
        expect(readFileSync(summary, "utf8")).toContain("### Documentation check: passed");
        const outputs = readFileSync(output, "utf8");
        expect(outputs).toContain(`dist=${repo.paths.dist}\n`);
        expect(outputs).toContain("page-url=https://docusystem-example.avunu.net/\n");
        expect(outputs).toMatch(/pages=\d+\n/);
      });

      test("the manual jx command is the one that was run, and `docusystem jx build` is the same build", async () => {
        const repo = cleanRepo();
        expect((await cli(repo, ["build"])).code).toBe(0);
        const routes = /^Done: (\d+) routes/m.exec(readFileSync(repo.paths.jxLog, "utf8"))?.[1];
        const passed = await cli(repo, ["jx", "build"]);
        expect(passed.code, passed.stderr).toBe(0);
        expect(passed.stdout).toContain(`Done: ${routes} routes`);
      });

      test("lint is clean, links passes on the published site, info says where everything is", async () => {
        const repo = cleanRepo();
        expect((await cli(repo, ["lint"])).code).toBe(0);
        expect((await cli(repo, ["build"])).code).toBe(0);
        const links = await cli(repo, ["links"]);
        expect(links.code, links.stderr).toBe(0);
        const info = JSON.parse((await cli(repo, ["info", "--json"])).stdout) as {
          jx: Record<string, string>;
          docusystem: { version: string };
          lastBuild: { strict: boolean } | null;
        };
        const pins = (
          JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
            dependencies: Record<string, string>;
          }
        ).dependencies;
        for (const [pkg, version] of Object.entries(info.jx)) expect(pins[pkg]).toBe(version);
        expect(info.lastBuild?.strict).toBe(true);
      });

      test("a second build is the same site", async () => {
        const repo = cleanRepo();
        await cli(repo, ["build"]);
        const first = listTree(repo.paths.dist);
        expect((await cli(repo, ["build"])).code).toBe(0);
        expect(listTree(repo.paths.dist)).toEqual(first);
      });
    });

    describe("a broken tree", () => {
      test("strict: exit 1, every problem once, nothing published", async () => {
        const repo = repoFrom("canary/broken");
        const { code, stdout, stderr } = await cli(repo, ["build"]);
        const all = `${stdout}\n${stderr}`;
        expect(code).toBe(1);
        expect(existsSync(repo.paths.dist)).toBe(false);
        // Each defect of the tree is noticed by someone, and named once:
        expect(occurrences(all, 'links to "guide/missing.md"')).toBe(1); // the broken relative link (Jx)
        expect(occurrences(all, 'references missing asset "assets/not-there.png"')).toBe(1); // the missing image (Jx)
        expect(all).toMatch(/lint: error: .*README\.md:\d+ .*Reference-style links/); // the reference link
        expect(all).toMatch(/lint: error: .*README\.md:\d+ .*Footnotes/); // the footnote
        expect(all).toMatch(/lint: warning: .*tasks\.md:\d+ .*Task-list/); // the task list (a warning)
        expect(all).toMatch(/lint: warning: .*README\.md:\d+ .*<a href>/); // the raw anchor (a warning)
        expect(all).toMatch(/docusystem: \d+ document problem\(s\) above fail the build\./);
      });

      test("strict: a failed build leaves the previous <site>/dist untouched", async () => {
        const repo = cleanRepo();
        expect((await cli(repo, ["build"])).code).toBe(0);
        const before = listTree(repo.paths.dist);
        const home = readFileSync(join(repo.paths.dist, "index.html"), "utf8");
        writeFileSync(join(repo.docsDir, "guide", "install.md"), "See [nothing](nothing.md).\n");
        const failed = await cli(repo, ["build"]);
        expect(failed.code).toBe(1);
        expect(listTree(repo.paths.dist)).toEqual(before);
        expect(readFileSync(join(repo.paths.dist, "index.html"), "utf8")).toBe(home);
      });

      test("lenient: the document problems are warnings, a tree without the raw anchor builds", async () => {
        const repo = repoFrom("canary/broken", {
          "docs/README.md": readFileSync(
            join(REPO_ROOT, "test", "fixtures", "canary", "broken", "docs", "README.md"),
            "utf8",
          )
            .split("\n")
            .filter((line) => !line.includes("<a href"))
            .join("\n"),
        });
        const { code, stdout, stderr } = await runCli(["build", "--lenient"], {
          cwd: repo.siteDir,
          env: jxEnv(),
        });
        expect(code, `${stdout}\n${stderr}`).toBe(0);
        expect(`${stdout}\n${stderr}`).toMatch(/document problem\(s\) above are only warnings/);
        expect(existsSync(join(repo.paths.dist, "index.html"))).toBe(true);
      });

      test("lenient does not downgrade the output assertions: a raw anchor is an empty link", async () => {
        const repo = repoFrom("canary/broken");
        const { code, stdout, stderr } = await runCli(["build", "--lenient"], {
          cwd: repo.siteDir,
          env: jxEnv(),
        });
        expect(code, `${stdout}\n${stderr}`).toBe(1);
        expect(`${stdout}\n${stderr}`).toMatch(/assert: FAIL/);
        expect(existsSync(repo.paths.dist)).toBe(false);
      });

      test("lint lists the Markdown problems as `level: file:line message` and exits 1", async () => {
        const repo = repoFrom("canary/broken");
        const { code, stdout } = await cli(repo, ["lint"]);
        expect(code).toBe(1);
        expect(stdout).toMatch(/^error: .*README\.md:\d+ .*Reference-style links/m);
        expect(stdout).toMatch(/^error: .*README\.md:\d+ .*Footnotes/m);
        expect(stdout).toMatch(/^lint: 2 error\(s\), \d+ warning\(s\)$/m);
      });

      test("check --ci annotates what it found, with the file and line of the lint errors", async () => {
        const repo = repoFrom("canary/broken");
        const { code, stdout } = await cli(repo, ["check", "--ci"]);
        expect(code).toBe(1);
        expect(stdout).toMatch(
          /^::error file=docs\/README\.md,line=\d+,title=lint::.*Reference-style links/m,
        );
        expect(stdout.split("\n").at(-1)).toBe("check: FAILED");
      });
    });

    describe("a hostile live catalog", () => {
      // The compiler evaluates a `${...}` in the text that a page renders, and the switcher renders the
      // title, slug and links of the catalog: `--refresh-catalog` must never let one through.
      test("--refresh-catalog refuses a catalog with a template expression: it is not compiled, the bundled catalog is used", async () => {
        const marker = join(tempDir(), "evaluated");
        const hostile = structuredClone(readBundledCatalogDocument());
        const victim = hostile.projects[1];
        if (victim === undefined)
          throw new Error("the bundled catalog has fewer than two projects");
        victim.title = `T\${process.getBuiltinModule(\`fs\`).writeFileSync(\`${marker}\`, \`x\`)}T`;
        victim.docs = "https://avunu.net/${process.cwd()}";
        const url = await serve(json(hostile));

        const repo = cleanRepo();
        const { code, stdout, stderr } = await cli(repo, ["build", "--refresh-catalog"], {
          DOCUSYSTEM_CATALOG_URL: url,
        });
        expect(code, `${stdout}\n${stderr}`).toBe(0);
        expect(`${stdout}\n${stderr}`).toMatch(
          /catalog: .*does not match the catalog contract; using the catalog bundled with/,
        );
        expect(`${stdout}\n${stderr}`).toContain('projects[1].title holds a "${"');
        expect(existsSync(marker)).toBe(false);
        expect(JSON.parse(readFileSync(repo.paths.manifest, "utf8")).catalog).toBe("bundled");
        const page = readFileSync(join(repo.paths.dist, "index.html"), "utf8");
        expect(page).not.toContain("T${");
        expect(page).not.toContain(dirname(marker));
      });
    });

    describe("two docusystem processes", () => {
      const children: Array<{ kill: () => void }> = [];
      afterEach(() => {
        for (const child of children.splice(0)) child.kill();
      });

      test("the second build exits 3, naming the pid that holds the lock", async () => {
        const repo = cleanRepo();
        // A live process that is not this one: its pid goes into the lock file.
        const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
          stdio: "ignore",
        });
        children.push(holder);
        const release = acquireLock(repo.paths, { pid: holder.pid });
        try {
          const { code, stderr } = await cli(repo, ["build"]);
          expect(code).toBe(3);
          expect(stderr).toContain(`pid ${holder.pid}`);
          expect(existsSync(repo.paths.dist)).toBe(false);
        } finally {
          release();
        }
        expect((await cli(repo, ["build"])).code).toBe(0);
      });
    });

    describe("docusystem dev", () => {
      const until = async (condition: () => boolean, ms = 30_000): Promise<void> => {
        const end = Date.now() + ms;
        while (!condition()) {
          if (Date.now() > end) throw new Error("timed out waiting");
          await new Promise((done) => setTimeout(done, 25));
        }
      };

      test("serves 200, 301 and 404, reloads after an edit and survives a broken edit", async () => {
        const repo = cleanRepo();
        const out: string[] = [];
        const err: string[] = [];
        const controller = new AbortController();
        const done = run(["dev", "--port", "0"], {
          cwd: repo.siteDir,
          env: jxEnv({ CI: "true" }), // dev is lenient anyway
          color: false,
          stdout: (line) => out.push(line),
          stderr: (line) => err.push(line),
          signal: controller.signal,
        });
        try {
          let exited = false;
          void done.then(() => {
            exited = true;
          });
          await until(() => out.some((line) => line.startsWith("dev: http://")) || exited);
          const start = out.find((line) => line.startsWith("dev: http://"));
          expect(start, err.join("\n")).toBeDefined();
          const base = /^dev: (http:\/\/127\.0\.0\.1:\d+)\//.exec(start!)![1]!;
          const get = async (path: string, init?: RequestInit) => fetch(`${base}${path}`, init);

          expect((await get("/")).status).toBe(200);
          expect((await get("/docs/")).status).toBe(200);
          const redirect = await get("/docs/guide/install", { redirect: "manual" });
          expect(redirect.status).toBe(301);
          expect(redirect.headers.get("location")).toBe("/docs/guide/install/");
          const notFound = await get("/nowhere/");
          expect(notFound.status).toBe(404);
          expect(await notFound.text()).toContain("</html>");

          // an edit rebuilds and reloads
          const stream = await get("/__reload");
          const reader = stream.body!.getReader();
          const seen: string[] = [];
          void (async () => {
            for (;;) {
              const { value, done: finished } = await reader.read();
              if (finished) return;
              seen.push(new TextDecoder().decode(value));
            }
          })();
          await until(() => seen.length > 0);
          writeFileSync(
            join(repo.docsDir, "guide", "install.md"),
            "---\ntitle: Installation\n---\n\n## Requirements\n\nChanged while dev was running.\n",
          );
          await until(() => seen.some((chunk) => chunk.includes("event: reload")));
          expect(await (await get("/docs/guide/install/")).text()).toContain(
            "Changed while dev was running.",
          );

          // a broken override fails the rebuild: the last good build is still served
          mkdirSync(join(repo.siteDir, "overrides", "pages"), { recursive: true });
          writeFileSync(join(repo.siteDir, "overrides", "pages", "index.json"), '{ "title": ');
          await until(() => out.some((line) => line.startsWith("dev: the build failed")));
          expect(await (await get("/docs/guide/install/")).text()).toContain(
            "Changed while dev was running.",
          );
          rmSync(join(repo.siteDir, "overrides"), { recursive: true, force: true });
          const before = seen.length;
          await until(
            () =>
              seen.length > before && seen.slice(before).some((c) => c.includes("event: reload")),
          );
          void reader.cancel();
        } finally {
          controller.abort();
          expect(await done).toBe(0);
        }
      });
    });
  },
);
