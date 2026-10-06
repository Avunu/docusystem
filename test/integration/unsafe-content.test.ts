// Documentation is other people's text on the project's own domain: the real pinned Jx and the real
// modules on a clean tree and on trees that a hostile documentation pull request could make. The three
// layers (lint, output assertions, Content-Security-Policy) are each shown to hold on their own here.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { policyProblems } from "../../src/lib/csp.js";
import { distFiles, htmlPages } from "../../src/lib/links.js";
import { runCli } from "../support/index.js";
import { jxEnv, repoFrom, type Repo } from "./support.js";

/** What `check` does in CI: a strict build and the checks after it. */
const strict = (repo: Repo, args: string[] = ["build"]) =>
  runCli(args, { cwd: repo.siteDir, env: jxEnv({ CI: "true" }) });
/** A build for writing documentation: the lint's errors are warnings. */
const lenient = (repo: Repo) => runCli(["build", "--lenient"], { cwd: repo.siteDir, env: jxEnv() });

const HOSTILE = [
  "---",
  "title: Hostile",
  "---",
  "",
  "# Hostile",
  "",
  '<div><img src="https://invalid.invalid/x.png" onerror="document.title=1"></div>',
  "",
  '<iframe src="javascript:top.document.title=1"></iframe>',
  "",
  '<details open ontoggle="document.title=1"><summary>x</summary>y</details>',
  "",
  '<script src="/evil.js"></script>',
  "",
  "[a link](javascript:alert(1)) and ![an image](data:image/svg+xml;base64,PHN2Zz4=)",
  "",
].join("\n");

const hostileRepo = (page: string) => repoFrom("canary/clean", { "docs/guide/hostile.md": page });

describe("a strict build of a tree with code in its Markdown", () => {
  test("is refused with the file and line of every construct, and publishes nothing", async () => {
    const repo = hostileRepo(HOSTILE);
    const { code, stdout, stderr } = await strict(repo);
    const all = `${stdout}\n${stderr}`;
    expect(code, all).toBe(1);
    expect(existsSync(repo.paths.dist)).toBe(false);
    const lint = all.split("\n").filter((line) => line.startsWith("lint: error: "));
    expect(lint.map((l) => /hostile\.md:(\d+)/.exec(l)?.[1])).toEqual([
      "7",
      "9",
      "11",
      "13",
      "15",
      "15",
    ]);
    expect(lint[0]).toContain("The onerror attribute on <img> is an event handler");
    expect(all).toMatch(/lint: error: docs\/guide\/hostile\.md:9 {2}<iframe> is not allowed/);
    expect(all).toMatch(/hostile\.md:13 {2}<script> is not allowed/);
    expect(all).toMatch(/hostile\.md:15 {2}The link is "javascript:alert\(1\)"/);
    expect(all).toMatch(/hostile\.md:15 {2}The image is "data:image\/svg\+xml;base64,PHN2Zz4="/);
    expect(all).toMatch(/docusystem: \d+ document problem\(s\) above fail the build\./);
  });

  test("`check --ci` annotates them", async () => {
    const repo = hostileRepo(HOSTILE);
    const { code, stdout } = await strict(repo, ["check", "--ci"]);
    expect(code).toBe(1);
    expect(stdout).toMatch(
      /^::error file=docs\/guide\/hostile\.md,line=9,title=lint::<iframe> is not allowed in documentation/m,
    );
    expect(stdout.split("\n").at(-1)).toBe("check: FAILED");
  });

  test("`lint` alone says the same", async () => {
    const repo = hostileRepo(HOSTILE);
    const { code, stdout } = await strict(repo, ["lint"]);
    expect(code).toBe(1);
    expect(stdout).toMatch(/^error: .*hostile\.md:9 .*<iframe> is not allowed/m);
  });
});

describe("a lenient build does not publish them either: the output assertions are never downgraded", () => {
  test("raw HTML, a link and an image", async () => {
    const repo = hostileRepo(HOSTILE);
    const { code, stdout, stderr } = await lenient(repo);
    const all = `${stdout}\n${stderr}`;
    expect(code, all).toBe(1);
    expect(all).toMatch(/lint: warning: docs\/guide\/hostile\.md:9 {2}<iframe> is not allowed/);
    expect(all).toMatch(
      /assert: FAIL: pages hold something that runs code or embeds another page: \/docs\/guide\/hostile\//,
    );
    expect(all).toMatch(/<img onerror="document\.title=1">, <iframe> and 5 more/);
    expect(all).toMatch(/Nothing was published\./);
    expect(existsSync(repo.paths.dist)).toBe(false);
  });

  test("a directive makes elements the lint's reading of HTML does not see, and the output refuses them", async () => {
    const repo = hostileRepo(
      [
        "---",
        "title: Hostile",
        "---",
        "",
        "# Hostile",
        "",
        ":script[document.title=1]",
        "",
        '::div{innerHTML="<img src=x onerror=document.title=1>"}',
        "",
        ':a[click]{href="javascript:alert(1)"}',
        "",
      ].join("\n"),
    );
    const strictRun = await strict(repo);
    expect(`${strictRun.stdout}\n${strictRun.stderr}`).toMatch(
      /hostile\.md:7 {2}The directive :script makes a <script> element/,
    );
    expect(strictRun.code).toBe(1);
    const { code, stdout, stderr } = await lenient(repo);
    const all = `${stdout}\n${stderr}`;
    expect(code, all).toBe(1);
    expect(all).toMatch(
      /\/docs\/guide\/hostile\/ \(<script> in the page content, <img onerror="document\.title=1"> and 1 more\)/,
    );
    expect(existsSync(repo.paths.dist)).toBe(false);
  });

  test("files that a page links to are published beside the pages, so an HTML, script or active SVG file is refused", async () => {
    const repo = repoFrom("canary/clean", {
      "docs/guide/files.md":
        "---\ntitle: Files\n---\n\n# Files\n\n[a page](evil.html), [a script](evil.js) and ![a picture](evil.svg), [a PDF](ok.pdf).\n",
      "docs/guide/evil.html": "<script>document.title=1</script>",
      "docs/guide/evil.js": "document.title=1",
      "docs/guide/evil.svg": '<svg xmlns="http://www.w3.org/2000/svg" onload="document.title=1"/>',
      "docs/guide/ok.pdf": "%PDF-1.4",
    });
    // nothing in the Markdown is HTML: the lint has nothing to say, the output does
    const { code, stdout, stderr } = await strict(repo);
    const all = `${stdout}\n${stderr}`;
    expect(code, all).toBe(1);
    expect(all).not.toMatch(/lint: error/);
    expect(all).toMatch(
      /assert: FAIL: files linked from the Markdown would run on the site's domain when opened: /,
    );
    expect(all).toContain("/content/docs/guide/evil.html (a .html file");
    expect(all).toContain("/content/docs/guide/evil.js (a .js file");
    expect(all).toMatch(/\/content\/docs\/guide\/evil\.svg \(onload="document\.title=1"\)/);
    expect(all).not.toContain("ok.pdf (");
    expect(existsSync(repo.paths.dist)).toBe(false);
  });
});

describe("a clean tree", () => {
  test("is built, and every page carries a policy that names its inline scripts", async () => {
    const repo = repoFrom("canary/clean");
    const { code, stdout, stderr } = await strict(repo);
    expect(code, `${stdout}\n${stderr}`).toBe(0);
    expect(stdout).toMatch(
      /^assert: ok: no page holds a script, an event handler, a javascript: address or an embedded page$/m,
    );
    expect(stdout).toMatch(
      /^assert: ok: every file published from the Markdown folder is a picture, a document or data, none runs$/m,
    );
    expect(stdout).toMatch(/^assert: ok: \d+ pages carry a Content-Security-Policy that blocks /m);
    const pages = htmlPages(repo.paths.dist);
    expect(pages.length).toBeGreaterThan(4);
    for (const file of pages) {
      const html = readFileSync(file, "utf8");
      expect(policyProblems(html), file).toEqual([]);
      expect(html.indexOf("Content-Security-Policy"), file).toBeLessThan(html.indexOf("<script"));
      expect(html.match(/<meta http-equiv="Content-Security-Policy"/g), file).toHaveLength(1);
    }
    // the SVG the README shows is a picture, and is published
    expect(distFiles(repo.paths.dist).some((f) => f.endsWith("square.svg"))).toBe(true);
  });

  test("a second build is the same site, policy included", async () => {
    const repo = repoFrom("canary/clean");
    await strict(repo);
    const first = readFileSync(join(repo.paths.dist, "index.html"), "utf8");
    await strict(repo);
    expect(readFileSync(join(repo.paths.dist, "index.html"), "utf8")).toBe(first);
  });
});
