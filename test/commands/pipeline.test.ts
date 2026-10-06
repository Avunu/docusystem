import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { LockError } from "../../src/lib/lock.js";
import {
  runPipelineWith,
  spawnCommand,
  type PipelineDeps,
  type PipelineOptions,
  type PipelineResult,
} from "../../src/lib/pipeline.js";
import { strictFailure } from "../../src/lib/strict.js";
import { fixture, listTree, tempDir } from "../support/index.js";
import { FAKE_JX, distFiles, makeWorld, publishedBefore, type World } from "./support/world.js";

const recorded = (name: string): string =>
  readFileSync(fixture("jx-output", `${name}.txt`), "utf8");

interface Run {
  result: PipelineResult;
  /** Standard output and standard error, as they would have interleaved. */
  all: string[];
  out: string[];
  err: string[];
}

/** Runs the pipeline of `world`; `shown` replaces the temporary folder and node by names that do not change. */
async function run(
  world: World,
  options: Partial<PipelineOptions> = {},
  deps: PipelineDeps = world.deps,
): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const all: string[] = [];
  const result = await runPipelineWith(
    {
      cwd: world.dir,
      env: {},
      log: (line) => {
        out.push(line);
        all.push(line);
      },
      error: (line) => {
        err.push(line);
        all.push(line);
      },
      ...options,
    },
    deps,
  );
  return { result, all, out, err };
}

const shown = (world: World, lines: string[]): string[] =>
  lines.map((line) =>
    line
      .replaceAll(world.dir, "<repo>")
      .replaceAll(process.execPath, "<node>")
      .replaceAll(FAKE_JX, "<jx>"),
  );

const countOf = (lines: string[], text: string): number =>
  lines.filter((line) => line.includes(text)).length;

const STEPS = [
  "findSiteDir",
  "preflight",
  "lock",
  "assemble",
  "stage",
  "lint",
  "nav",
  "jx",
  "postbuild",
  "assert",
  "publish",
  "unlock",
];

describe("a clean build", () => {
  test("runs the steps in the order of 5.1, holds the lock around them and publishes <site>/dist", async () => {
    const world = makeWorld();
    const { result } = await run(world, { env: { CI: "true" } });
    expect(world.calls).toEqual(STEPS);
    expect(result.ok).toBe(true);
    expect(result.strict).toBe(true);
    expect(result.pages).toBe(6);
    expect(result.problems).toEqual([]);
    expect(result.paths).toBe(world.paths);
    expect(result.config).toBe(world.config);
    expect(result.nav?.home.url).toBe("/docs/");
    expect(result.assembly?.manifest.docusystem).toBe("0.1.0");
    expect(distFiles(world)).toEqual({
      "index.html": "<html>build 1</html>\n",
      "docs/index.html": "<html>docs 1</html>\n",
    });
    // the lock is held while the root is assembled
    expect(world.seen.lockHeld).toEqual([true]);
  });

  test("prints one prefix per stage and the manual jx command (snapshot)", async () => {
    const world = makeWorld();
    const { out, err } = await run(world, { env: { CI: "true" } });
    expect(err).toEqual([]);
    expect(shown(world, out)).toEqual([
      "preflight: site <repo>/docs-site, Markdown <repo>/docs, branch main, strict (document problems fail the build)",
      "assemble: 5 file(s) in <repo>/docs-site/.docusystem/site (docusystem 0.1.0, @jxsuite/compiler 5.0.0)",
      "catalog: bundled snapshot",
      "stage: 5 file(s), 0 link(s) to repository files rewritten",
      "nav: 4 page(s)",
      "jx: <node> <jx> build <repo>/docs-site/.docusystem/site",
      "Building site from <repo>/docs-site/.docusystem/site...",
      "",
      "Done: 6 routes → 40 files",
      "postbuild: 6 page(s), 5 in the sitemap, 5 canonical URL(s) set, 0 search title(s) fixed, CNAME present",
      "assert: ok: CNAME equals the configured domain",
      "build: 6 page(s) written to <repo>/docs-site/dist",
      "build: overrides: none (every file comes from the package)",
      "build: to run Jx by hand on the assembled project: <node> <jx> build <repo>/docs-site/.docusystem/site",
    ]);
  });

  test("writes jx.log with everything Jx printed, and runs Jx in the root", async () => {
    const world = makeWorld();
    await run(world);
    expect(readFileSync(world.paths.jxLog, "utf8")).toBe(
      `Building site from ${world.paths.root}...\n\nDone: 6 routes → 40 files\n`,
    );
    expect(world.seen.runJx).toEqual([
      { command: [process.execPath, FAKE_JX, "build", world.paths.root], cwd: world.paths.root },
    ]);
  });

  test("lists every override, shadowed or added, with the catalog source", async () => {
    const world = makeWorld();
    world.shadowed = ["components/docs-footer.json"];
    world.added = ["pages/about.json"];
    world.catalog = "live";
    const { out } = await run(world);
    expect(out).toContain(
      "overrides: components/docs-footer.json replaces the package's file (it does not follow package updates)",
    );
    expect(out).toContain("overrides: pages/about.json is added to the package's files");
    expect(out).toContain("catalog: live copy");
    expect(out).toContain(
      "build: overrides: components/docs-footer.json (replaces the package's file), pages/about.json (added)",
    );
  });

  test("passes the strictness, the branch and the catalog options on", async () => {
    const world = makeWorld();
    await run(world, {
      lenient: true,
      refreshCatalog: true,
      env: { DOCUSYSTEM_CATALOG_URL: "http://127.0.0.1:1/projects.json" },
    });
    const args = world.seen.assemble[0];
    expect(args?.strict).toBe(false);
    expect(args?.refreshCatalog).toBe(true);
    expect(args?.catalogUrl).toBe("http://127.0.0.1:1/projects.json");
    expect(args?.branch).toBe("main");
    expect(world.seen.postbuild[0]?.config.branch).toBe("main");
    expect(world.seen.assertions).toEqual([
      {
        cname: "example.avunu.net",
        routes: 6,
        // each page of the nav with the Markdown file it was built from, as lint prints it
        sources: {
          "/docs/": "docs/README.md",
          "/docs/page-1/": "docs/page-1.md",
          "/docs/page-2/": "docs/page-2.md",
          "/docs/page-3/": "docs/page-3.md",
        },
      },
    ]);
  });

  test("does not ask the catalog for a refresh unless it is asked", async () => {
    const world = makeWorld();
    await run(world);
    expect(world.seen.assemble[0]?.refreshCatalog).toBeUndefined();
    expect(world.seen.assemble[0]?.catalogUrl).toBeUndefined();
  });

  test("a second build replaces the first site completely", async () => {
    const world = makeWorld();
    publishedBefore(world);
    await run(world);
    expect(listTree(world.paths.dist)).toEqual([
      "404.html",
      "docs/",
      "docs/index.html",
      "index.html",
    ]);
  });
});

describe("strictness", () => {
  test("CI=true is strict, --lenient and DOCUSYSTEM_LENIENT=1 are not, --strict is", async () => {
    for (const [options, expected] of [
      [{ env: { CI: "true" } }, true],
      [{ env: { CI: "true" }, lenient: true }, false],
      [{ env: { CI: "true", DOCUSYSTEM_LENIENT: "1" } }, false],
      [{ strict: true }, true],
      [{}, false],
    ] as Array<[Partial<PipelineOptions>, boolean]>) {
      const world = makeWorld();
      const { result } = await run(world, options);
      expect(result.strict).toBe(expected);
      expect(world.seen.assemble[0]?.strict).toBe(expected);
    }
  });
});

describe("a strict build with document problems", () => {
  const problems = (world: World): void => {
    world.lint = [
      {
        file: "README.md",
        line: 14,
        level: "error",
        rule: "reference-link",
        message: "Reference-style links are not rendered.",
      },
      {
        file: "README.md",
        line: 12,
        level: "warning",
        rule: "raw-anchor",
        message: "An inline <a href> keeps its text but loses the link.",
      },
      {
        file: "guide/x.md",
        line: 15,
        level: "error",
        rule: "footnote",
        message: "Footnotes are not rendered.",
      },
    ];
    world.jx.output = recorded("broken-warn").replaceAll("/work/site", world.paths.root);
    world.navPages = 2; // the recorded run built 4 routes: 2 pages and the 2 static ones
  };

  test("fails with every problem listed once and nothing published; the previous site is untouched", async () => {
    const world = makeWorld();
    problems(world);
    const before = publishedBefore(world);
    const { result, all, err } = await run(world, { env: { CI: "true" } });

    expect(result.ok).toBe(false);
    expect(world.calls).toEqual([
      "findSiteDir",
      "preflight",
      "lock",
      "assemble",
      "stage",
      "lint",
      "nav",
      "jx",
      "unlock",
    ]);
    expect(distFiles(world)).toEqual({ ...before, "extra.txt": undefined });
    expect(readFileSync(join(world.paths.dist, "extra.txt"), "utf8")).toBe(
      "only in the old site\n",
    );

    // The lint errors and the Jx lines, together, each exactly once.
    expect(countOf(all, "Reference-style links are not rendered.")).toBe(1);
    expect(countOf(all, "Footnotes are not rendered.")).toBe(1);
    expect(countOf(all, 'references missing asset "assets/not-there.png"')).toBe(1);
    expect(countOf(all, '"README.md" links to "guide/missing.md"')).toBe(1);
    // 2 lint errors + 2 Jx lines; the warning is not counted.
    expect(err.at(-1)).toBe(strictFailure(4));
    expect(err).toContain(
      "lint: error: docs/README.md:14  Reference-style links are not rendered.",
    );
    expect(err).toContain(
      "lint: warning: docs/README.md:12  An inline <a href> keeps its text but loses the link.",
    );
  });

  test("the problems are in the result, as errors, the warning as a warning", async () => {
    const world = makeWorld();
    problems(world);
    const { result } = await run(world, { strict: true });
    expect(result.problems.filter((p) => p.level === "error")).toHaveLength(4);
    expect(result.problems.filter((p) => p.level === "warning")).toHaveLength(1);
    expect(result.problems).toContainEqual({
      level: "error",
      message: "Reference-style links are not rendered.",
      file: "docs/README.md",
      line: 14,
    });
  });

  test("a failed Jx run lists the broken links with the lint errors and prints the manual command", async () => {
    const world = makeWorld();
    world.lint = [
      {
        file: "README.md",
        line: 14,
        level: "error",
        rule: "reference-link",
        message: "Reference-style links are not rendered.",
      },
    ];
    world.jx.code = 1;
    world.jx.output = recorded("broken-error").replaceAll("/work/site", world.paths.root);
    const before = publishedBefore(world);
    const { result, all, err } = await run(world, { strict: true });

    expect(result.ok).toBe(false);
    expect(world.calls).not.toContain("postbuild");
    expect(world.calls).not.toContain("publish");
    expect(world.calls.at(-1)).toBe("unlock");
    expect(distFiles(world)).toMatchObject({ "index.html": before["index.html"] });
    expect(err.filter((line) => line.startsWith("docusystem: jx build failed."))).toEqual([
      `docusystem: jx build failed. The assembled project is ${world.paths.root}; run: ${process.execPath} ${FAKE_JX} build ${world.paths.root}`,
    ]);
    // the lint error, the missing asset, the broken link: three problems, and Jx's own text printed once
    expect(err.at(-1)).toBe(strictFailure(3));
    expect(countOf(all, '"README.md" links to "guide/missing.md", which does not exist')).toBe(1);
    expect(countOf(all, "Reference-style links are not rendered.")).toBe(1);
    expect(readFileSync(world.paths.jxLog, "utf8")).toContain("Build failed: Content links");
  });

  test("a strict build whose Jx run exits 0 but printed problem lines fails before post-processing", async () => {
    const world = makeWorld();
    world.jx.output = `Building site...\nWarning: Referenced asset not found: /x.png\n\nDone: 6 routes → 40 files\n`;
    const { result, err } = await run(world, { strict: true });
    expect(result.ok).toBe(false);
    expect(world.calls).not.toContain("postbuild");
    expect(err.at(-1)).toBe(strictFailure(1));
  });

  test("a skipped symbolic link is a document problem", async () => {
    const world = makeWorld();
    world.stage = { skipped: [{ path: "x.md", reason: "a symbolic link outside the repository" }] };
    const { result, err } = await run(world, { strict: true });
    expect(result.ok).toBe(false);
    expect(err).toContain(
      "stage: docs/x.md is a symbolic link outside the repository: not published",
    );
    expect(err.at(-1)).toBe(strictFailure(1));
    expect(result.problems).toContainEqual({
      level: "error",
      message: "docs/x.md is a symbolic link outside the repository: not published",
      file: "docs/x.md",
    });
  });

  test("so is a skipped link in overrides/ or public/", async () => {
    const world = makeWorld();
    // WP2 reports the path relative to the site folder; the pipeline words it from the repository root
    world.assemblySkipped = [{ path: "public/logo.svg", reason: "a symbolic link into .git" }];
    const { result, out, err } = await run(world, { strict: true, ci: true });
    expect(result.ok).toBe(false);
    expect(err).toContain(
      "assemble: docs-site/public/logo.svg is a symbolic link into .git: not published",
    );
    expect(out).toContain(
      "::error file=docs-site/public/logo.svg,title=assemble::docs-site/public/logo.svg is a symbolic link into .git: not published",
    );
    expect(err.at(-1)).toBe(strictFailure(1));
  });
});

describe("a lenient build with the same problems", () => {
  test("downgrades lint errors and Jx lines to warnings, publishes, and says so", async () => {
    const world = makeWorld();
    world.lint = [
      {
        file: "README.md",
        line: 14,
        level: "error",
        rule: "reference-link",
        message: "Reference-style links are not rendered.",
      },
    ];
    world.jx.output = recorded("broken-warn").replaceAll("/work/site", world.paths.root);
    world.navPages = 2;
    const { result, err } = await run(world, { lenient: true, env: { CI: "true" } });

    expect(result.ok).toBe(true);
    expect(result.strict).toBe(false);
    expect(world.calls).toEqual(STEPS);
    expect(distFiles(world)["index.html"]).toBe("<html>build 1</html>\n");
    expect(err).toContain(
      "lint: warning: docs/README.md:14  Reference-style links are not rendered.",
    );
    expect(err.at(-1)).toMatch(
      /^docusystem: 3 document problem\(s\) above are only warnings because the build is lenient\./,
    );
    expect(result.problems.every((p) => p.level === "warning")).toBe(true);
    expect(result.problems).toHaveLength(3);
  });

  test("a failing Jx run, a failed assertion and a missing Done line are not downgraded as such", async () => {
    // Jx failing is never a warning.
    const failing = makeWorld();
    failing.jx.code = 1;
    failing.jx.output = recorded("compile-error").replaceAll("/work/site", failing.paths.root);
    const failed = await run(failing, { lenient: true });
    expect(failed.result.ok).toBe(false);
    expect(failing.calls).not.toContain("publish");
    expect(failed.err.some((line) => line.startsWith("docusystem: jx build failed."))).toBe(true);
    // no strict summary in a lenient build: the document problems were not what failed it
    expect(failed.err.some((line) => line.includes("fail the build"))).toBe(false);

    // An assertion failing is never a warning.
    const asserting = makeWorld();
    asserting.assertions = [
      { ok: true, message: "ok one" },
      {
        ok: false,
        message: "no registered custom element is left empty: docs-footer is empty on /docs/",
      },
    ];
    const asserted = await run(asserting, { lenient: true });
    expect(asserted.result.ok).toBe(false);
    expect(asserting.calls).not.toContain("publish");
  });
});

describe("a failed Jx run", () => {
  test("names the assembled project and the command to run by hand, and fails in every mode", async () => {
    for (const options of [{ strict: true }, { lenient: true }] as Array<
      Partial<PipelineOptions>
    >) {
      const world = makeWorld();
      world.jx.code = 1;
      world.jx.output = recorded("compile-error").replaceAll("/work/site", world.paths.root);
      const before = publishedBefore(world);
      const { result, err } = await run(world, options);
      expect(result.ok).toBe(false);
      expect(result.pages).toBe(0);
      expect(err).toContain(
        `docusystem: jx build failed. The assembled project is ${world.paths.root}; run: ${process.execPath} ${FAKE_JX} build ${world.paths.root}`,
      );
      expect(distFiles(world)["index.html"]).toBe(before["index.html"]);
      expect(world.calls.at(-1)).toBe("unlock");
    }
  });

  test("adds the hint about images when the output mentions sharp", async () => {
    const world = makeWorld();
    world.jx.code = 1;
    world.jx.output =
      "Error: Could not load the sharp module using the linux-x64 runtime\nlibstdc++.so.6: cannot open shared object file\n";
    const { err } = await run(world);
    expect(
      err.some((line) =>
        line.startsWith("docusystem: hint: Jx could not load its native image library (sharp)"),
      ),
    ).toBe(true);
    expect(err.join("\n")).toContain('"images": "off"');
  });

  test("no hint for an ordinary failure", async () => {
    const world = makeWorld();
    world.jx.code = 1;
    world.jx.output = recorded("compile-error");
    const { err } = await run(world);
    expect(err.some((line) => line.includes("hint:"))).toBe(false);
  });

  test("Jx that cannot be started rejects, and the lock is released", async () => {
    const world = makeWorld();
    world.jx.throws = new Error("spawn ENOENT");
    await expect(run(world)).rejects.toThrow("spawn ENOENT");
    expect(world.calls.at(-1)).toBe("unlock");
  });
});

describe("the route count", () => {
  test("fewer routes than the nav and the static pages promise: Jx dropped routes (strict: fails)", async () => {
    const world = makeWorld();
    world.jx.output = "Building...\n\nDone: 5 routes → 38 files\n";
    const { result, err } = await run(world, { strict: true });
    expect(result.ok).toBe(false);
    expect(world.calls).not.toContain("publish");
    expect(err.find((line) => line.startsWith("jx: error: Jx dropped routes"))).toContain(
      "it built 5, the documents and the site's own pages promise 6",
    );
    expect(err.at(-1)).toBe(strictFailure(1));
  });

  test("lenient: the same is a warning and the build goes on", async () => {
    const world = makeWorld();
    world.jx.output = "Building...\n\nDone: 5 routes → 38 files\n";
    const { result, err } = await run(world, { lenient: true });
    expect(result.ok).toBe(true);
    expect(err.some((line) => line.startsWith("jx: warning: Jx dropped routes"))).toBe(true);
  });

  test("more routes are fine (a dynamic page of an override)", async () => {
    const world = makeWorld();
    world.jx.output = "Building...\n\nDone: 9 routes → 38 files\n";
    expect((await run(world, { strict: true })).result.ok).toBe(true);
  });

  test("no Done line at all: the count cannot be checked, which a strict build does not accept", async () => {
    const world = makeWorld();
    world.jx.output = "Building...\nfinished\n";
    const strict = await run(world, { strict: true });
    expect(strict.result.ok).toBe(false);
    expect(strict.err.find((line) => line.startsWith("jx: error:"))).toContain(
      'Jx printed no "Done: N routes" line',
    );
    const lenient = await run(makeWorld(), { lenient: true });
    expect(lenient.result.ok).toBe(true);
  });
});

describe("output assertions", () => {
  test("a failed assertion fails the build in strict and lenient mode and publishes nothing", async () => {
    for (const options of [{ strict: true }, { lenient: true }] as Array<
      Partial<PipelineOptions>
    >) {
      const world = makeWorld();
      world.assertions = [
        { ok: true, message: "one h1 per page" },
        { ok: false, message: "CNAME is example.org, not example.avunu.net" },
        { ok: false, message: "fonts/ has no woff2 file" },
      ];
      const before = publishedBefore(world);
      const { result, out, err } = await run(world, options);
      expect(result.ok).toBe(false);
      expect(world.calls).toContain("assert");
      expect(world.calls).not.toContain("publish");
      expect(distFiles(world)["index.html"]).toBe(before["index.html"]);
      expect(out).toContain("assert: ok: one h1 per page");
      expect(err).toContain("assert: FAIL: CNAME is example.org, not example.avunu.net");
      expect(err).toContain("docusystem: 2 output assertion(s) failed. Nothing was published.");
    }
  });

  const LENIENT_ONLY = "a lenient build (the default outside CI, and always `docusystem dev`)";
  const LINT_CAUSE = "If a lint warning above is about the page an assertion names";
  const rawAnchor = (): World["lint"] => [
    {
      file: "page-1.md",
      line: 5,
      level: "warning",
      rule: "html-inline",
      message: "An inline <a href> keeps its text but loses the link.",
    },
  ];
  const emptyLink = (): World["assertions"] => [
    {
      ok: false,
      message: "links with nothing inside: /docs/page-1/ from docs/page-1.md (<a href>)",
    },
  ];

  test("a lenient build says that leniency does not reach the assertion, and where the cause is", async () => {
    const world = makeWorld();
    world.lint = rawAnchor();
    world.assertions = emptyLink();
    const { result, err } = await run(world, { lenient: true });
    expect(result.ok).toBe(false);
    // the lint warning with its file and line, then the failure naming the same file, then why it still fails
    expect(err).toContain(
      "lint: warning: docs/page-1.md:5  An inline <a href> keeps its text but loses the link.",
    );
    expect(err).toContain(
      "assert: FAIL: links with nothing inside: /docs/page-1/ from docs/page-1.md (<a href>)",
    );
    expect(err.slice(-2)).toEqual([
      "docusystem: 1 output assertion(s) failed. Nothing was published.",
      expect.stringContaining(LENIENT_ONLY),
    ]);
    expect(err.at(-1)).toContain("output assertions fail every build");
    expect(err.at(-1)).toContain(LINT_CAUSE);
  });

  test("a lenient build without lint output says only that leniency does not reach the assertion", async () => {
    const world = makeWorld();
    world.assertions = [{ ok: false, message: "CNAME is missing" }];
    const { err } = await run(world, { lenient: true });
    expect(err.slice(-2)).toEqual([
      "docusystem: 1 output assertion(s) failed. Nothing was published.",
      expect.stringContaining("output assertions fail every build."),
    ]);
    expect(err.at(-1)).not.toContain(LINT_CAUSE);
  });

  test("a strict build keeps the one line, and adds the pointer to the lint line only when lint printed something", async () => {
    const bare = makeWorld();
    bare.assertions = [{ ok: false, message: "CNAME is missing" }];
    const plain = await run(bare, { strict: true });
    expect(plain.err.at(-1)).toBe(
      "docusystem: 1 output assertion(s) failed. Nothing was published.",
    );
    expect(plain.err.some((line) => line.includes("lenient"))).toBe(false);

    const world = makeWorld();
    world.lint = rawAnchor();
    world.assertions = emptyLink();
    const { err } = await run(world, { strict: true });
    expect(err.slice(-2)).toEqual([
      "docusystem: 1 output assertion(s) failed. Nothing was published.",
      `docusystem: ${LINT_CAUSE}, that warning is the cause: fix it.`,
    ]);
    expect(err.some((line) => line.includes("lenient"))).toBe(false);
  });

  test("a lenient build that an assertion stopped does not claim the document problems are only warnings", async () => {
    // A document problem (a skipped symbolic link) that lenient downgrades, and an assertion that fails.
    const stopped = makeWorld();
    stopped.stage = {
      skipped: [{ path: "x.md", reason: "a symbolic link outside the repository" }],
    };
    stopped.assertions = emptyLink();
    const failed = await run(stopped, { lenient: true });
    expect(failed.result.ok).toBe(false);
    expect(failed.all.some((line) => line.includes("only warnings"))).toBe(false);

    // The same problem with every assertion passing: the notice is given, after the assertions, and the site is published.
    const goes = makeWorld();
    goes.stage = { skipped: [{ path: "x.md", reason: "a symbolic link outside the repository" }] };
    const passed = await run(goes, { lenient: true });
    expect(passed.result.ok).toBe(true);
    const notice = passed.all.findIndex((line) => line.includes("only warnings"));
    expect(notice).toBeGreaterThan(passed.all.findIndex((line) => line.startsWith("assert: ok:")));
    expect(countOf(passed.all, "only warnings")).toBe(1);
    expect(goes.calls).toContain("publish");
  });

  test("post-build warnings are printed and never fatal", async () => {
    const world = makeWorld();
    world.deps.runPostbuild = (...args) => {
      const summary = makeWorld().deps.runPostbuild(...args);
      return {
        ...summary,
        warnings: [
          "docs/a.md uses the code fence language zig, which the highlighter does not know",
        ],
      };
    };
    const { result, err } = await run(world, { strict: true });
    expect(result.ok).toBe(true);
    expect(err).toContain(
      "postbuild: warning: docs/a.md uses the code fence language zig, which the highlighter does not know",
    );
  });
});

describe("what stops the pipeline early", () => {
  test("preflight errors are all printed, nothing else runs and no lock is taken", async () => {
    const world = makeWorld();
    world.preflightErrors = ["slug is wrong", "docs/README.md is missing"];
    world.preflightWarnings = ["a warning"];
    const { result, err } = await run(world);
    expect(result.ok).toBe(false);
    expect(world.calls).toEqual(["findSiteDir", "preflight"]);
    expect(err).toEqual([
      "preflight: warning: a warning",
      "preflight: error: slug is wrong",
      "preflight: error: docs/README.md is missing",
    ]);
    expect(result.paths).toBeUndefined();
  });

  test("the site folder not found is a preflight error", async () => {
    const world = makeWorld();
    world.deps.findSiteDir = () => {
      throw new Error("no docusystem.config.json in /x (searched /x, /x/docs-site)");
    };
    const { result, err } = await run(world);
    expect(result.ok).toBe(false);
    expect(err).toEqual([
      "preflight: error: no docusystem.config.json in /x (searched /x, /x/docs-site)",
    ]);
  });

  test("a bug in a neighbour (a TypeError) is not swallowed", async () => {
    const world = makeWorld();
    world.deps.findSiteDir = () => {
      throw new TypeError("x is not a function");
    };
    await expect(run(world)).rejects.toThrow(TypeError);
  });

  test("a ConfigError from preflight lists every problem", async () => {
    const world = makeWorld();
    const { ConfigError } = await import("../../src/lib/config.js");
    world.deps.preflight = () => {
      throw new ConfigError(["name is required", "domain is not a domain"]);
    };
    const { result, err } = await run(world);
    expect(result.ok).toBe(false);
    expect(err).toEqual([
      "preflight: error: name is required",
      "preflight: error: domain is not a domain",
    ]);
  });

  test("assembly lines are printed as WP2 words them (they carry their own prefix); errors stop the run before staging", async () => {
    const world = makeWorld();
    world.assemblyErrors = [
      "overrides: overrides/components/sub/x.json is nested: Jx registers only components/*.json",
      "bare error without a prefix",
    ];
    world.assemblyWarnings = [
      "overrides: jx.$media replaces 5 entries of the package's list",
      "catalog: https://avunu.net/projects.json answered 404; using the catalog bundled with docusystem 0.1.0",
    ];
    const { result, err } = await run(world, { strict: true });
    expect(result.ok).toBe(false);
    expect(world.calls).toEqual(["findSiteDir", "preflight", "lock", "assemble", "unlock"]);
    expect(err).toEqual([
      "overrides: jx.$media replaces 5 entries of the package's list",
      "catalog: https://avunu.net/projects.json answered 404; using the catalog bundled with docusystem 0.1.0",
      "overrides: overrides/components/sub/x.json is nested: Jx registers only components/*.json",
      "assemble: bare error without a prefix",
      "docusystem: the project could not be assembled (2 error(s) above): nothing was built",
    ]);
    expect(result.problems).toEqual([
      { level: "warning", message: "jx.$media replaces 5 entries of the package's list" },
      {
        level: "warning",
        message:
          "https://avunu.net/projects.json answered 404; using the catalog bundled with docusystem 0.1.0",
      },
      {
        level: "error",
        message: "overrides/components/sub/x.json is nested: Jx registers only components/*.json",
      },
      { level: "error", message: "bare error without a prefix" },
    ]);
    expect(result.assembly).toBeDefined();
  });

  test("a lock held by another process is not caught: the error reaches main.ts, which exits 3", async () => {
    const world = makeWorld();
    world.lockError = new LockError(4242);
    await expect(run(world)).rejects.toThrow("another docusystem process (pid 4242) is running");
    expect(world.calls).toEqual(["findSiteDir", "preflight", "lock"]);
  });

  test("a thrown error in a step still releases the lock", async () => {
    const world = makeWorld();
    world.deps.stageSite = () => {
      throw new Error("docs/ has more than 50000 files");
    };
    await expect(run(world)).rejects.toThrow("more than 50000");
    expect(world.calls.at(-1)).toBe("unlock");
  });
});

describe("stopAfterNav (docusystem jx, info --nav)", () => {
  test("assembles, stages, lints and writes the nav, never runs Jx, and succeeds despite lint errors", async () => {
    const world = makeWorld();
    world.lint = [
      {
        file: "a.md",
        line: 1,
        level: "error",
        rule: "footnote",
        message: "Footnotes are not rendered.",
      },
    ];
    const { result, err } = await run(world, { stopAfterNav: true, strict: true });
    expect(result.ok).toBe(true);
    expect(world.calls).toEqual([
      "findSiteDir",
      "preflight",
      "lock",
      "assemble",
      "stage",
      "lint",
      "nav",
      "unlock",
    ]);
    expect(existsSync(world.paths.navFile)).toBe(true);
    expect(existsSync(world.paths.dist)).toBe(false);
    expect(err).toContain("lint: error: docs/a.md:1  Footnotes are not rendered.");
  });

  test("the hook runs while the lock is still held, and the lock is released after it", async () => {
    const world = makeWorld();
    let during: string[] = [];
    const out: string[] = [];
    const result = await runPipelineWith(
      { cwd: world.dir, env: {}, stopAfterNav: true, log: (l) => out.push(l) },
      world.deps,
      {
        whileLocked: async (assembled) => {
          during = [...world.calls];
          expect(assembled.paths?.root).toBe(world.paths.root);
          await Promise.resolve();
        },
      },
    );
    expect(result.ok).toBe(true);
    expect(during.at(-1)).toBe("nav");
    expect(during).not.toContain("unlock");
    expect(world.calls.at(-1)).toBe("unlock");
  });

  test("the hook is not called when the run did not get as far", async () => {
    const world = makeWorld();
    world.assemblyErrors = ["broken"];
    let called = false;
    await runPipelineWith(
      { cwd: world.dir, env: {}, stopAfterNav: true, log: () => {} },
      world.deps,
      {
        whileLocked: async () => {
          called = true;
        },
      },
    );
    expect(called).toBe(false);
  });
});

describe("--ci annotations (byte for byte)", () => {
  test("every error and every located warning is also a workflow command", async () => {
    const world = makeWorld();
    world.lint = [
      {
        file: "guide/x.md",
        line: 15,
        level: "error",
        rule: "footnote",
        message: "Footnotes are not rendered.",
      },
      {
        file: "guide/x.md",
        line: 20,
        level: "warning",
        rule: "task-list",
        message: "Task lists are plain lists.",
      },
    ];
    world.stage = {
      skipped: [{ path: "link.md", reason: "a symbolic link outside the repository" }],
    };
    world.jx.output = `Building...\nContent links: "docs": "a.md" links to "b.md", which does not exist; it renders as plain text.\n\nDone: 6 routes → 40 files\n`;
    world.navWarnings = ["two pages share an address"];
    const { out, err } = await run(world, { strict: true, ci: true });
    const commands = out.filter((line) => line.startsWith("::"));
    expect(commands).toEqual([
      "::error file=docs/link.md,title=stage::docs/link.md is a symbolic link outside the repository: not published",
      "::error file=docs/guide/x.md,line=15,title=lint::Footnotes are not rendered.",
      "::warning file=docs/guide/x.md,line=20,title=lint::Task lists are plain lists.",
      '::error title=jx::Content links: "docs": "a.md" links to "b.md", which does not exist; it renders as plain text.',
    ]);
    // a warning without a location is printed, not annotated
    expect(err).toContain("nav: warning: two pages share an address");
    expect(commands.some((line) => line.includes("two pages share"))).toBe(false);
  });

  test("a Markdown folder that is not docs/ is named by the printed line and by the annotation alike", async () => {
    // "docs": "../documentation": GitHub can attach an annotation only to a file that exists
    const world = makeWorld();
    world.paths.docsDir = join(world.dir, "documentation");
    world.lint = [
      { file: "café.md", line: 9, level: "error", rule: "footnote", message: "Footnotes." },
      { file: "guide/x.md", line: 2, level: "warning", rule: "task-list", message: "Tasks." },
    ];
    world.stage = {
      skipped: [{ path: "link.md", reason: "a symbolic link outside the repository" }],
    };
    const { out, err } = await run(world, { strict: true, ci: true });
    expect(err).toContain("lint: error: documentation/café.md:9  Footnotes.");
    expect(err).toContain("lint: warning: documentation/guide/x.md:2  Tasks.");
    expect(out.filter((line) => line.startsWith("::"))).toEqual([
      "::error file=documentation/link.md,title=stage::documentation/link.md is a symbolic link outside the repository: not published",
      "::error file=documentation/café.md,line=9,title=lint::Footnotes.",
      "::warning file=documentation/guide/x.md,line=2,title=lint::Tasks.",
    ]);
    expect([...out, ...err].filter((line) => line.includes("docs/"))).toEqual([]);
  });

  test("the Markdown folder, relative to the repository, is what the navigation is told", async () => {
    const world = makeWorld();
    world.paths.docsDir = join(world.dir, "documentation");
    const asked: unknown[] = [];
    const writeNav = world.deps.writeNav;
    world.deps.writeNav = (paths, config, o) => {
      asked.push(o);
      return writeNav(paths, config, o);
    };
    await run(world, { strict: true });
    expect(asked).toEqual([{ folder: "documentation" }]);
  });

  test("annotations are on standard output with the rest of the progress, and absent without ci", async () => {
    const world = makeWorld();
    world.lint = [{ file: "x.md", line: 1, level: "error", rule: "footnote", message: "m" }];
    const withCi = await run(world, { strict: true, ci: true });
    expect(withCi.out.some((line) => line.startsWith("::error"))).toBe(true);
    expect(withCi.err.some((line) => line.startsWith("::"))).toBe(false);
    const without = await run(makeWorld({}), { strict: true });
    expect(without.all.some((line) => line.startsWith("::"))).toBe(false);
  });

  test("a failed Jx run, a failed assertion and a preflight error are annotated without a file", async () => {
    const world = makeWorld();
    world.jx.code = 1;
    world.jx.output = recorded("compile-error");
    const jx = await run(world, { ci: true });
    expect(jx.out).toContain(
      `::error title=jx::jx build failed (exit code 1); see ${world.paths.jxLog}`,
    );

    const asserting = makeWorld();
    asserting.assertions = [{ ok: false, message: "100% of pages\nhave an h1" }];
    expect((await run(asserting, { ci: true })).out).toContain(
      "::error title=assert::100%25 of pages%0Ahave an h1",
    );

    const preflight = makeWorld();
    preflight.preflightErrors = ["slug is wrong"];
    expect((await run(preflight, { ci: true })).out).toEqual([
      "::error title=preflight::slug is wrong",
    ]);
  });
});

describe("spawnCommand", () => {
  const node = (script: string): string[] => [process.execPath, "-e", script];

  test("collects standard output and standard error in order and reports each line with its stream", async () => {
    const lines: Array<[string, string]> = [];
    const script =
      'process.stdout.write("a\\n"); setTimeout(() => process.stderr.write("b\\n"), 30); setTimeout(() => process.stdout.write("c\\nd"), 60);';
    const result = await spawnCommand(node(script), {
      cwd: tempDir(),
      env: process.env,
      onLine: (line, stream) => lines.push([stream, line]),
    });
    expect(result).toEqual({ code: 0, output: "a\nb\nc\nd" });
    expect(lines).toEqual([
      ["stdout", "a"],
      ["stderr", "b"],
      ["stdout", "c"],
      ["stdout", "d"],
    ]);
  });

  test("the exit code is returned, standard input is closed, and the working folder is the one given", async () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, "marker.txt"), "here");
    const script =
      'let s=""; process.stdin.on("data",d=>s+=d); process.stdin.on("end",()=>{ console.log(require("fs").readFileSync("marker.txt","utf8") + ":" + s.length); process.exit(7); });';
    const result = await spawnCommand(node(script), { cwd, env: process.env });
    expect(result).toEqual({ code: 7, output: "here:0\n" });
  });

  test("a command that cannot be started rejects", async () => {
    await expect(
      spawnCommand(["/nonexistent/docusystem-test-binary"], { cwd: tempDir(), env: {} }),
    ).rejects.toThrow(/ENOENT/);
    await expect(spawnCommand([], { cwd: tempDir(), env: {} })).rejects.toThrow("no command");
  });
});
