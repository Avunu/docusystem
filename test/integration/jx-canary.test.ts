// The canary: the REAL pinned Jx on a clean and on a broken documentation tree, through the real
// pipeline (section 9.2 of the architecture record). Every Dependabot bump of a Jx package and the
// weekly jx-latest run this, so a change of Jx's wording, exit codes or route counting is caught here
// and not in a consumer's pull request. The neighbours of the pipeline are stand-ins (see support.ts);
// canary.test.ts repeats the trees through the real modules.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runPipelineWith, type PipelineOptions } from "../../src/lib/pipeline.js";
import { doneRoutes, problemsIn, strictFailure } from "../../src/lib/strict.js";
import { listTree } from "../support/index.js";
import { JX_CLI, jxDeps, jxEnv, repoFrom, type JxRepoOptions, type Repo } from "./support.js";

async function build(repo: Repo, options: Partial<PipelineOptions> = {}, jx: JxRepoOptions = {}) {
  const all: string[] = [];
  const result = await runPipelineWith(
    {
      cwd: repo.dir,
      env: jxEnv(),
      log: (line) => all.push(line),
      error: (line) => all.push(line),
      ...options,
    },
    jxDeps(repo, jx),
  );
  return { result, all };
}

const occurrences = (lines: string[], text: string): number =>
  lines.filter((line) => line.includes(text)).length;

describe("the pinned Jx on a clean tree", () => {
  test("a strict build prints no problem line, parses `Done: N routes` and publishes", async () => {
    const repo = repoFrom("canary/clean");
    const { result, all } = await build(repo, { strict: true });
    expect(result.ok, all.join("\n")).toBe(true);
    expect(result.problems).toEqual([]);

    const log = readFileSync(repo.paths.jxLog, "utf8");
    expect(problemsIn(log)).toEqual([]);
    // 4 documentation pages, the home page and the 404 page
    expect(doneRoutes(log)).toBe(6);
    expect(log).toMatch(/^Done: 6 routes/m);

    expect(existsSync(join(repo.paths.dist, "index.html"))).toBe(true);
    expect(existsSync(join(repo.paths.dist, "docs", "guide", "install", "index.html"))).toBe(true);
    // no stage printed a warning or an error
    expect(all.filter((line) => /: (warning|error): /.test(line))).toEqual([]);
  });

  test("the manual jx command it prints runs, from any folder, and reproduces the build", async () => {
    const repo = repoFrom("canary/clean");
    const { all } = await build(repo, { strict: true });
    const line = all.find((l) =>
      l.startsWith("build: to run Jx by hand on the assembled project: "),
    );
    expect(line).toBeDefined();
    const command = line!.slice("build: to run Jx by hand on the assembled project: ".length);
    expect(command).toContain(JX_CLI);
    expect(command).toContain(repo.paths.root);
    const manual = spawnSync("/bin/sh", ["-c", command], {
      cwd: "/",
      env: jxEnv(),
      encoding: "utf8",
    });
    expect(manual.status, manual.stderr).toBe(0);
    expect(doneRoutes(manual.stdout)).toBe(6);
  });

  test("a lenient build of a clean tree is the same", async () => {
    const repo = repoFrom("canary/clean");
    const { result } = await build(repo, { lenient: true });
    expect(result.ok).toBe(true);
    expect(result.strict).toBe(false);
  });
});

describe("the pinned Jx on a broken tree", () => {
  test("strict: exits 1 with every problem listed once, and publishes nothing", async () => {
    const repo = repoFrom("canary/broken");
    const { result, all } = await build(repo, { strict: true });
    expect(result.ok).toBe(false);
    expect(existsSync(repo.paths.dist)).toBe(false);

    // The missing image and the broken link, each exactly once, in Jx's own words...
    expect(occurrences(all, 'references missing asset "assets/not-there.png"')).toBe(1);
    expect(occurrences(all, '"README.md" links to "guide/missing.md", which does not exist')).toBe(
      1,
    );
    expect(all).toContain(
      "docusystem: jx build failed. The assembled project is " +
        `${repo.paths.root}; run: ${process.execPath} ${JX_CLI} build ${repo.paths.root}`,
    );
    // ...and Jx's failure is what stopped it: links are errors in a strict build.
    expect(readFileSync(repo.paths.jxLog, "utf8")).toContain("Build failed: Content links");
    // the two problems that only Jx knows, counted together
    expect(all.at(-1)).toBe(strictFailure(2));
    expect(result.problems.filter((problem) => problem.level === "error")).toHaveLength(3); // + jx failed
  });

  test("strict failure leaves the previous site exactly as it was", async () => {
    const repo = repoFrom("canary/clean");
    expect((await build(repo, { strict: true })).result.ok).toBe(true);
    const before = listTree(repo.paths.dist);
    const index = readFileSync(join(repo.paths.dist, "index.html"), "utf8");

    // break the same repository and build again
    writeFileSync(
      join(repo.docsDir, "guide", "install.md"),
      "See [the missing page](missing.md).\n",
    );
    const { result, all } = await build(repo, { strict: true });
    expect(result.ok).toBe(false);
    expect(all.at(-1)).toMatch(/document problem\(s\) above fail the build/);
    expect(listTree(repo.paths.dist)).toEqual(before);
    expect(readFileSync(join(repo.paths.dist, "index.html"), "utf8")).toBe(index);
  });

  test("lenient: exits 0, the same problems are warnings, the site is published", async () => {
    const repo = repoFrom("canary/broken");
    // the stand-in nav counts the two Markdown files; Jx builds them plus the two static pages
    const { result, all } = await build(repo, { lenient: true });
    expect(result.ok, all.join("\n")).toBe(true);
    expect(result.strict).toBe(false);
    expect(result.problems.map((problem) => problem.level)).toEqual(["warning", "warning"]);
    expect(occurrences(all, 'references missing asset "assets/not-there.png"')).toBe(1);
    expect(occurrences(all, '"README.md" links to "guide/missing.md"')).toBe(1);
    expect(
      all.some((line) => /^docusystem: 2 document problem\(s\) above are only warnings/.test(line)),
    ).toBe(true);
    expect(existsSync(join(repo.paths.dist, "index.html"))).toBe(true);
  });

  test("CI=true is strict and DOCUSYSTEM_LENIENT=1 is not, as in a real run", async () => {
    const plain = await build(repoFrom("canary/broken"));
    expect(plain.result.strict).toBe(false); // jxEnv() has no CI: lenient by default
    expect(plain.result.ok).toBe(true);
    const ci = await build(repoFrom("canary/broken"), { env: jxEnv({ CI: "true" }) });
    expect(ci.result.ok).toBe(false);
    expect(ci.result.strict).toBe(true);
    const lenient = await build(repoFrom("canary/broken"), {
      env: jxEnv({ CI: "true", DOCUSYSTEM_LENIENT: "1" }),
    });
    expect(lenient.result.ok).toBe(true);
  });
});

describe("what Jx does not say, the pipeline checks", () => {
  test("two pages with one address: Jx prints two Content lines and carries on, which a strict build does not accept", async () => {
    const repo = repoFrom("canary/clean", {
      "docs/guide.md": "---\ntitle: Guide A\n---\n\nA page.\n",
      "docs/guide/README.md": "---\ntitle: Guide B\n---\n\nAnother page with the same address.\n",
    });
    const strict = await build(repo, { strict: true });
    expect(strict.result.ok).toBe(false);
    expect(strict.all.filter((line) => line.startsWith("Content ids:"))).toHaveLength(1);
    expect(strict.all.filter((line) => line.startsWith("Content routes:"))).toHaveLength(1);
    expect(strict.all.at(-1)).toBe(strictFailure(2));
    expect(existsSync(repo.paths.dist)).toBe(false);
    // the nav of the stand-in is keyed by address, so the two pages are one: the count agrees with Jx's
    expect(strict.all.some((line) => line.includes("Jx dropped routes"))).toBe(false);

    const lenient = await build(repo, { lenient: true });
    expect(lenient.result.ok).toBe(true);
    expect(lenient.result.problems).toHaveLength(2);
  });

  test("a page the nav promises and Jx does not route: Jx dropped routes (strict fails, lenient warns)", async () => {
    // Jx leaves out files whose name starts with `_`; this stand-in nav (unlike WP3's) lists it.
    const repo = repoFrom("canary/clean", {
      "docs/_notes.md": "---\ntitle: Notes\n---\n\nNotes.\n",
    });
    const strict = await build(repo, { strict: true });
    expect(strict.result.ok).toBe(false);
    const dropped = strict.all.find((line) => line.startsWith("jx: error: Jx dropped routes"));
    // 5 documentation pages + 2 static pages are promised, Jx built 6
    expect(dropped).toContain("it built 6, the documents and the site's own pages promise 7");
    expect(strict.all.at(-1)).toBe(strictFailure(1));
    expect(existsSync(repo.paths.dist)).toBe(false);

    const lenient = await build(repo, { lenient: true });
    expect(lenient.result.ok).toBe(true);
    expect(lenient.all.some((line) => line.startsWith("jx: warning: Jx dropped routes"))).toBe(
      true,
    );
  });

  test("a page that does not compile fails the build in every mode, with the command to reproduce it", async () => {
    for (const options of [{ strict: true }, { lenient: true }] as Array<
      Partial<PipelineOptions>
    >) {
      const repo = repoFrom("canary/clean");
      const { result, all } = await build(repo, options, {
        rootFiles: { "pages/index.json": '{ "title": "x", ' },
      });
      expect(result.ok).toBe(false);
      expect(result.pages).toBe(0);
      expect(
        all.some((line) => line.startsWith("Error compiling /: Failed to parse Jx document")),
      ).toBe(true);
      expect(
        all.find((line) =>
          line.startsWith("docusystem: jx build failed. The assembled project is"),
        ),
      ).toContain(`run: ${process.execPath} ${JX_CLI} build ${repo.paths.root}`);
      expect(existsSync(repo.paths.dist)).toBe(false);
    }
  });
});
