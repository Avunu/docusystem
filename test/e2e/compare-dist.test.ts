import { cpSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { tempDir, writeTree } from "../support/index.js";
import { builder, runScript, script, type BuildOptions } from "./support.js";

// scripts/compare-dist.mjs: identical for two builds of the same input, and a difference in any file that
// the build controls is reported; only the order of component blocks and (for builds on different
// runtimes) the bytes of the three vendored bundles are ignored.

interface Compare {
  normalizeHtml(html: string): {
    skeleton: string;
    styles: string[][];
    scripts: string[];
    preloads: string[];
  };
  compareDist(
    a: string,
    b: string,
    o?: { allow?: string[]; runtimeA?: string; runtimeB?: string; vendored?: string },
  ): {
    equal: boolean;
    differences: Array<{ path: string; kind: string; detail: string }>;
    allowed: unknown[];
    skipped: string[];
  };
  VENDORED: RegExp;
}

let make: (options?: BuildOptions) => string;
let compare: Compare;

beforeAll(async () => {
  const { buildDist } = await builder();
  make = (options = {}) => buildDist(join(tempDir("docusystem-compare-"), "dist"), options);
  compare = await script<Compare>("compare-dist.mjs");
});

const run = (a: string, b: string, ...args: string[]) =>
  runScript("compare-dist.mjs", [a, b, ...args]);
const vendored = [
  "assets/lit-html.js",
  "assets/vue-reactivity.js",
  "assets/jxsuite-search-client.js",
];

/** A site with the three vendored bundles, as Jx writes them. */
const withBundles = (text = "bundle") =>
  make({ extraFiles: Object.fromEntries(vendored.map((f) => [f, `${text} ${f}`])) });

describe("two builds of the same input", () => {
  it("are identical", () => {
    const r = run(make(), make());
    expect(r.code).toBe(0);
    expect(r.output).toMatch(/0 difference\(s\): identical/);
  });

  it("are identical when compared with themselves", () => {
    const dist = make();
    expect(run(dist, dist).code).toBe(0);
  });
});

describe("a difference the build controls", () => {
  it("is flagged when one byte of a script differs", () => {
    const a = make();
    const b = make();
    writeFileSync(join(b, "components", "docs-toc.js"), "export { }");
    const r = run(a, b);
    expect(r.code).toBe(1);
    expect(r.output).toMatch(/^DIFF {2}components\/docs-toc\.js/m);
    expect(r.output).toMatch(/1 difference\(s\): DIFFERENT/);
  });

  it("is flagged when one byte of a page differs", () => {
    const a = make();
    const b = make();
    const file = join(b, "docs", "guide", "index.html");
    writeFileSync(file, readFileSync(file, "utf8").replace("Text.", "Text!"));
    const r = run(a, b);
    expect(r.code).toBe(1);
    expect(r.output).toMatch(
      /^DIFF {2}docs\/guide\/index\.html {2}\(the page differs: first difference at character \d+/m,
    );
  });

  it("is flagged when a binary file differs", () => {
    const a = make({ extraFiles: { "images/a.bin": "aaaa" } });
    const b = make({ extraFiles: { "images/a.bin": "aaab" } });
    expect(run(a, b).output).toMatch(/DIFF {2}images\/a\.bin/);
  });

  it("is flagged when a file is on one side only", () => {
    const a = make();
    const b = make({ extraFiles: { "extra.txt": "x" } });
    expect(run(a, b).output).toMatch(/DIFF {2}extra\.txt {2}\(only in B\)/);
    expect(run(b, a).output).toMatch(/DIFF {2}extra\.txt {2}\(only in A\)/);
  });

  it("is flagged when a symbolic link is published", () => {
    const a = make();
    const b = make();
    symlinkSync(join(b, "favicon.svg"), join(b, "link.svg"));
    expect(run(a, b).output).toMatch(/DIFF {2}link\.svg {2}\(a symbolic link in B\)/);
  });

  it("is reported with --allow, without failing", () => {
    const a = make();
    const b = make();
    writeFileSync(join(b, "components", "docs-toc.js"), "export { }");
    const r = run(a, b, "--allow", "components/docs-toc.js");
    expect(r.code).toBe(0);
    expect(r.output).toMatch(/^allowed {2}components\/docs-toc\.js/m);
    expect(r.output).toMatch(/0 difference\(s\), 1 allowed: identical/);
  });

  it("is not excused by --allow for another file", () => {
    const a = make();
    const b = make();
    writeFileSync(join(b, "components", "docs-toc.js"), "export { }");
    expect(run(a, b, "--allow", "components/docs-footer.js").code).toBe(1);
  });
});

describe("the order of component blocks", () => {
  const page = (styles: string[], scripts: string[], preloads: string[]) =>
    `<html><head><style>\n${styles.join("\n\n")}\n</style>${preloads
      .map((n) => `<link rel="modulepreload" href="/components/${n}.js">`)
      .join("")}</head><body>x${scripts
      .map((n) => `<script type="module" src="/components/${n}.js"></script>`)
      .join("")}</body></html>`;

  const css = ["a { color: red }", "b { color: blue }", "c { margin: 0 }"];
  const names = ["docs-enhance", "docs-search", "theme-toggle"];

  it("is ignored: component CSS, module scripts and modulepreload links in another order are equal", () => {
    const a = tempDir();
    const b = tempDir();
    writeTree(a, { "index.html": page(css, names, names) });
    writeTree(b, {
      "index.html": page([...css].reverse(), [...names].reverse(), [...names].reverse()),
    });
    const r = run(a, b);
    expect(r.code, r.output).toBe(0);
  });

  it("is not a licence to change them: a changed rule, a missing script and a missing link are flagged", () => {
    const a = tempDir();
    const changedCss = tempDir();
    const missingScript = tempDir();
    const missingPreload = tempDir();
    writeTree(a, { "index.html": page(css, names, names) });
    writeTree(changedCss, {
      "index.html": page(["a { color: green }", ...css.slice(1)], names, names),
    });
    writeTree(missingScript, { "index.html": page(css, names.slice(1), names) });
    writeTree(missingPreload, { "index.html": page(css, names, names.slice(1)) });
    expect(run(a, changedCss).output).toMatch(/style block 1 differs/);
    expect(run(a, missingScript).output).toMatch(
      /the page differs.*<module\/><module\/><module\/>/,
    );
    expect(run(a, missingPreload).output).toMatch(/the page differs.*<preload\/><preload\/>/);
  });

  it("moves nothing else: text between the blocks must stay where it is", () => {
    const a = tempDir();
    const b = tempDir();
    writeTree(a, { "index.html": page(css, names, names) });
    writeTree(b, { "index.html": page(css, names, names).replace("x<script", "y<script") });
    expect(run(a, b).code).toBe(1);
  });

  it("normalizeHtml keeps the order-free parts apart from the page", () => {
    const normal = compare.normalizeHtml(page(css, names, names));
    expect(normal.skeleton).toContain("<module/>");
    expect(normal.skeleton).toContain("<preload/>");
    expect(normal.skeleton).not.toContain("color: red");
    expect(normal.styles).toEqual([[...css].sort()]);
    expect(normal.scripts).toHaveLength(3);
  });
});

describe("the vendored bundles", () => {
  const changed = () => {
    const a = withBundles("one");
    const b = tempDir("docusystem-compare-");
    cpSync(a, join(b, "dist"), { recursive: true });
    for (const f of vendored) writeFileSync(join(b, "dist", f), `two ${f}`);
    return [a, join(b, "dist")] as const;
  };

  it("are compared byte for byte when the runtimes are not stated", () => {
    const [a, b] = changed();
    const r = run(a, b);
    expect(r.code).toBe(1);
    for (const f of vendored) expect(r.output).toContain(`DIFF  ${f}`);
  });

  it("are compared when both builds ran on the same runtime", () => {
    const [a, b] = changed();
    expect(run(a, b, "--runtime-a", "bun", "--runtime-b", "bun").code).toBe(1);
    expect(run(a, b, "--runtime-a", "node", "--runtime-b", "node").code).toBe(1);
  });

  it("are skipped, and listed, when the builds ran on different runtimes", () => {
    const [a, b] = changed();
    const r = run(a, b, "--runtime-a", "bun", "--runtime-b", "node");
    expect(r.code).toBe(0);
    for (const f of vendored) expect(r.output).toContain(`skipped  ${f}`);
    expect(r.output).toMatch(/3 vendored bundle\(s\) skipped: identical/);
  });

  it("follow --vendored: skip never compares, compare always does", () => {
    const [a, b] = changed();
    expect(run(a, b, "--vendored", "skip").code).toBe(0);
    expect(
      run(a, b, "--vendored", "compare", "--runtime-a", "bun", "--runtime-b", "node").code,
    ).toBe(1);
  });

  it("must still exist on both sides, whatever the runtimes", () => {
    const a = withBundles();
    const b = make();
    const r = run(a, b, "--runtime-a", "bun", "--runtime-b", "node");
    expect(r.code).toBe(1);
    expect(r.output).toContain("DIFF  assets/lit-html.js  (only in A)");
  });

  it("are the three Jx vendors and nothing else", () => {
    for (const f of vendored) expect(compare.VENDORED.test(f)).toBe(true);
    expect(compare.VENDORED.test("assets/other.js")).toBe(false);
    expect(compare.VENDORED.test("components/docs-enhance.js")).toBe(false);
  });
});

describe("the result", () => {
  it("is printed as JSON on request, the summary going to standard error", () => {
    const a = make();
    const b = make();
    writeFileSync(join(b, "components", "docs-toc.js"), "export { }");
    const r = run(a, b, "--json");
    const json = JSON.parse(r.stdout) as {
      equal: boolean;
      differences: Array<{ path: string; kind: string }>;
    };
    expect(json.equal).toBe(false);
    expect(json.differences).toEqual([
      expect.objectContaining({ path: "components/docs-toc.js", kind: "content" }),
    ]);
    expect(r.stderr).toMatch(/DIFFERENT/);
  });

  it("compareDist can be called directly", () => {
    const a = make();
    const b = make();
    expect(compare.compareDist(a, b).equal).toBe(true);
    mkdirSync(join(b, "new"), { recursive: true });
    writeFileSync(join(b, "new", "file.txt"), "x");
    expect(compare.compareDist(a, b).differences).toEqual([
      { path: "new/file.txt", kind: "only-b", detail: "only in B" },
    ]);
  });
});

describe("usage errors", () => {
  it.each([
    [[], /usage: node scripts\/compare-dist\.mjs/],
    [["a"], /usage: node scripts\/compare-dist\.mjs/],
    [["a", "b", "--runtime-a", "deno"], /--runtime-a must be one of node, bun/],
    [["a", "b", "--vendored", "maybe"], /--vendored must be one of auto, compare, skip/],
    [["a", "b", "--nope"], /Unknown option/],
    [["/nonexistent-a", "/nonexistent-b"], /is not a folder/],
  ] as Array<[string[], RegExp]>)("%j exits 2", (args, message) => {
    const r = runScript("compare-dist.mjs", args);
    expect(r.code).toBe(2);
    expect(r.output).toMatch(message);
  });

  it("--help prints the usage and exits 0", () => {
    const r = runScript("compare-dist.mjs", ["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/usage: node scripts\/compare-dist\.mjs/);
  });
});
