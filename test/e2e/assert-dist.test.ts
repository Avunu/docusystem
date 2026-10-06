import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { tempDir } from "../support/index.js";
import { builder, runScript, type BuildOptions } from "./support.js";

// scripts/assert-dist.mjs, against sites written by hand (fixtures/stub-cli/builder.mjs): every assertion
// has a passing site and a failing one. The same script checks a real build in scripts/test-pack.mjs.

let make: (options?: BuildOptions) => { dist: string; config: string };

beforeAll(async () => {
  const { buildDist, configOf, SITE } = await builder();
  make = (options = {}) => {
    const dir = tempDir("docusystem-assert-");
    const dist = buildDist(join(dir, "dist"), options);
    const config = join(dir, "docusystem.config.json");
    writeFileSync(config, JSON.stringify(configOf(options.site ?? SITE)));
    return { dist, config };
  };
});

const assertDist = (options: BuildOptions, extra: string[] = []) => {
  const { dist, config } = make(options);
  return runScript("assert-dist.mjs", [dist, config, ...extra]);
};

describe("a complete site", () => {
  it("passes every assertion", () => {
    const run = assertDist({});
    expect(run.output).not.toMatch(/^FAIL/m);
    expect(run.code).toBe(0);
    expect(run.output).toMatch(/assert-dist: (\d+)\/\1 checks passed/);
  });

  it("asserts at least the 19 independent assertions of the prototype", () => {
    const run = assertDist({});
    expect(run.output.match(/^ok /gm)?.length).toBeGreaterThanOrEqual(19);
  });

  it("is happy with a hidden placeholder link such as the pager's missing neighbour", () => {
    expect(assertDist({ breaks: ["hidden-link"] }).code).toBe(0);
  });

  it("checks the counts, links, resources and titles it is told to", async () => {
    const { PAGES } = await builder();
    const run = assertDist(
      {
        hrefs: ["https://github.com/Avunu/example/blob/main/src/a.ts"],
        srcs: ["https://github.com/Avunu/example/raw/main/a.svg"],
      },
      [
        ...["--pages", "2", "--alerts", "3"],
        ...["--href", "https://github.com/Avunu/example/blob/main/src/a.ts"],
        ...["--src", "https://github.com/Avunu/example/raw/main/a.svg"],
        ...PAGES.flatMap((p) => ["--title", `${p.route}=${p.title}`]),
      ],
    );
    expect(run.output).not.toMatch(/^FAIL/m);
    expect(run.output).toMatch(/ok {3}2 documentation pages/);
    expect(run.output).toMatch(/ok {3}3 GitHub alerts became callouts/);
    expect(run.output).toMatch(/every expected link is present \(1\)/);
    expect(run.output).toMatch(/every expected resource is loaded \(1\)/);
    expect(run.output).toMatch(/page titles are as expected \(2\)/);
    expect(run.code).toBe(0);
  });

  it("prints JSON on request, the human lines going to standard error", () => {
    const run = assertDist({}, ["--json"]);
    const json = JSON.parse(run.stdout) as { passed: boolean; results: Array<{ ok: boolean }> };
    expect(json.passed).toBe(true);
    expect(json.results.every((r) => r.ok)).toBe(true);
    expect(run.stderr).toMatch(/checks passed/);
  });
});

describe("a site that is missing or spoils one thing fails the assertion for it", () => {
  // [what is spoiled, the assertion that must fail]
  const cases: Array<[string, RegExp]> = [
    ["no-cname", /CNAME says the configured domain/],
    ["wrong-cname", /CNAME says the configured domain/],
    ["no-nojekyll", /\.nojekyll is published/],
    ["404-folder", /404\.html is published/],
    ["md-copy", /no Markdown copies/],
    ["few-fonts", /self-hosted fonts are published/],
    ["no-favicon-ico", /favicons and brand marks/],
    ["font-face-remote", /@font-face points at \/fonts\//],
    ["font-host", /no third-party font host/],
    ["no-dark", /light and dark themes/],
    ["no-toggle", /light and dark themes/],
    ["landing-no-name", /landing page names the project/],
    ["two-h1", /every page has exactly one h1/],
    ["title-expr", /non-empty <title> without a template expression/],
    ["template-expr", /no template expression left unevaluated/],
    ["callout-type", /every callout has a known type/],
    ["empty-element", /no registered custom element is left empty/],
    ["empty-link", /no link without an address or without text/],
    ["empty-href", /no link without an address or without text/],
    ["md-link", /no link of the site itself ends in \.md/],
    ["broken-link", /every internal link, image and script resolves/],
    ["broken-asset", /every internal link, image and script resolves/],
    ["img-no-src", /every image of a page has a source/],
    ["no-canonical", /canonical address and og:url/],
    ["wrong-canonical", /canonical address and og:url/],
    ["og-missing", /canonical address and og:url/],
    ["sitemap-no-slash", /sitemap uses the configured domain and trailing slashes/],
    ["sitemap-missing-page", /sitemap lists every page except 404/],
    ["sitemap-404", /the sitemap does not list the 404 page/],
    ["no-search-index", /search index covers every documentation page/],
    ["search-missing-page", /search index covers every documentation page/],
    ["no-search-ui", /search UI shipped/],
    ["no-sidebar", /the sidebar of a documentation page lists every documentation page/],
    ["sidebar-missing-page", /the sidebar of a documentation page lists every documentation page/],
    ["switcher-empty", /project switcher is pre-rendered from the catalog/],
    ["no-catalog-url", /project switcher script/],
  ];

  it.each(cases)("%s", (spoil, assertion) => {
    const run = assertDist({ breaks: [spoil] });
    const failed = run.output.split("\n").filter((line) => line.startsWith("FAIL"));
    expect(failed.length, run.output).toBeGreaterThanOrEqual(1);
    expect(
      failed.some((line) => assertion.test(line)),
      failed.join("\n"),
    ).toBe(true);
    expect(run.code).toBe(1);
  });

  it("an extra documentation page breaks the page count and the search coverage", () => {
    const run = assertDist({ breaks: ["extra-page"] }, ["--pages", "2"]);
    expect(run.output).toMatch(/FAIL 2 documentation pages {2}\(3\)/);
    expect(run.output).toMatch(/FAIL search index covers every documentation page/);
  });

  it("the wrong number of alerts fails", () => {
    expect(assertDist({}, ["--alerts", "5"]).output).toMatch(
      /FAIL 5 GitHub alerts became callouts {2}\(3\)/,
    );
  });

  it("a link or resource that is not on any page fails", () => {
    const run = assertDist({}, [
      "--href",
      "https://example.net/nope",
      "--src",
      "https://example.net/nope.png",
    ]);
    expect(run.output).toMatch(
      /FAIL every expected link is present \(1\) {2}\(1: https:\/\/example\.net\/nope\)/,
    );
    expect(run.output).toMatch(/FAIL every expected resource is loaded \(1\)/);
  });

  it("a title that differs fails and says what it was", () => {
    const run = assertDist({}, ["--title", "/docs/=Something else"]);
    expect(run.output).toMatch(
      /FAIL page titles are as expected \(1\) {2}\(1: \/docs\/: "Documentation · Example Site", wanted "Something else"\)/,
    );
  });

  it("a page the title is asked about that does not exist fails", () => {
    expect(assertDist({}, ["--title", "/docs/missing/=x"]).output).toMatch(
      /\/docs\/missing\/: no such page/,
    );
  });
});

describe("usage errors", () => {
  const { dist, config } = { dist: "dist", config: "config.json" };

  it.each([
    [[], /expected a dist folder and a config file/],
    [[dist], /expected a dist folder and a config file/],
    [[dist, config, "--unknown"], /Unknown option/],
    [["--pages", "x", dist, config], /--pages must be a whole number/],
    [["--title", "no-equals", dist, config], /--title wants <route>=<text>/],
  ] as Array<[string[], RegExp]>)("%j exits 2", (args, message) => {
    const run = runScript("assert-dist.mjs", args);
    expect(run.code).toBe(2);
    expect(run.output).toMatch(message);
  });

  it("a dist that is not a folder exits 2", () => {
    const run = runScript("assert-dist.mjs", ["/nonexistent-folder", "x.json"]);
    expect(run.code).toBe(2);
    expect(run.output).toMatch(/is not a folder/);
  });

  it("a config that cannot be read, or has no domain, exits 2", () => {
    const { dist: folder } = make({});
    expect(runScript("assert-dist.mjs", [folder, "/nonexistent.json"]).code).toBe(2);
    const dir = tempDir();
    const file = join(dir, "c.json");
    writeFileSync(file, JSON.stringify({ name: "x", tagline: "y" }));
    const run = runScript("assert-dist.mjs", [folder, file]);
    expect(run.code).toBe(2);
    expect(run.output).toMatch(/has no "domain"/);
  });

  it("--help prints the usage and exits 0", () => {
    const run = runScript("assert-dist.mjs", ["--help"]);
    expect(run.code).toBe(0);
    expect(run.stdout).toMatch(/usage: node scripts\/assert-dist\.mjs/);
  });
});
