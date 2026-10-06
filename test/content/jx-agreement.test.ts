// docs.ts and slug.ts mirror what Jx decides when it loads the `docs` content type: which files are
// excluded, which pages are published, what a page's URL is. nav.ts writes the sidebar before Jx
// runs, so a disagreement is a sidebar link to a page that does not exist (or a page the sidebar
// does not list). This test runs the two over the same inputs.
//
// Two sources of truth are compared:
//   - Jx itself: the pure rule and route modules of the pinned @jxsuite/parser, loaded from the
//     installed package by file (they are not exported subpaths). If Jx moves them, this test fails
//     and says so; update it with the pin (the `jx` Dependabot group runs it).
//   - site/project.base.json (WP7): the rules the base project declares. Until that file is
//     merged the rules come from fixtures/docs-content-type.json (a copy from the starter); once it
//     exists, the second test below compares it to the fixture and the first one reads it.
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import { isExcluded, isIndexName, isPublished, urlFor } from "../../src/lib/docs.js";
import { humanize, slugifyPath, slugifySegment } from "../../src/lib/slug.js";
import { REPO_ROOT } from "../support/index.js";

interface Rules {
  exclude: string[];
  where: Record<string, unknown>;
  route: string;
  indexRoute: string;
}

const fixtureRules = JSON.parse(
  readFileSync(join(REPO_ROOT, "test", "content", "fixtures", "docs-content-type.json"), "utf8"),
) as Rules & { $comment: string };
const baseFile = join(REPO_ROOT, "site", "project.base.json");
const baseRules: Rules | null = existsSync(baseFile)
  ? ((JSON.parse(readFileSync(baseFile, "utf8")) as { content: { docs: Rules } }).content.docs ??
    null)
  : null;
const rules: Rules = baseRules ?? fixtureRules;

// ---- Jx's own code, from the installed package -------------------------------------------------

interface JxRoutes {
  slugifySegment: (text: string) => string;
  slugifyPath: (text: string) => string;
  isDirectoryIndex: (path: string) => boolean;
  parseRouteConfig: (route: unknown, indexRoute: unknown, type: string) => unknown;
  renderRoute: (
    spec: unknown,
    subject: { id: string; data: Record<string, unknown>; path: string },
  ) => { route: string } | { error: string };
  routeHref: (route: string, trailingSlash: string) => string;
}
interface JxRules {
  compileExclude: (patterns: readonly string[]) => {
    excludedBy: (path: string) => string | undefined;
  };
  compileWhere: (where: unknown) => (data: Record<string, unknown>) => boolean;
}

async function loadJx(): Promise<{ routes: JxRoutes; rules: JxRules }> {
  const require = createRequire(import.meta.url);
  const source = dirname(require.resolve("@jxsuite/parser"));
  const load = async <T>(file: string): Promise<T> => {
    const path = join(source, file);
    if (!existsSync(path)) {
      throw new Error(
        `@jxsuite/parser no longer has ${file} next to its main file: Jx moved its content rules. ` +
          "Find where `renderRoute`, `slugifySegment`, `compileExclude` and `compileWhere` live now " +
          "and point this test at them: docs.ts and slug.ts must keep agreeing with them.",
      );
    }
    return (await import(/* @vite-ignore */ pathToFileURL(path).href)) as T;
  };
  return {
    routes: await load<JxRoutes>("content-routes.ts"),
    rules: await load<JxRules>("content-rules.ts"),
  };
}

const jx = await loadJx();

// ---- inputs ------------------------------------------------------------------------------------

/** A small deterministic generator (mulberry32), so a failure reproduces. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = [
  ..."abcXYZ019 _-.&'’,;:!?()[]{}#%@+*~/\\",
  ..."éèüñçåøßŁ",
  ..."ǅ", // a titlecase letter
  ..."日本語中文",
  ..."приветмир",
  ..."हिन्दीकि", // Devanagari: the combining marks are vowels, not accents
  ..."ไทย",
  "́", // a combining accent on its own
  "😀",
  "\t",
];

function randomText(next: () => number, max: number): string {
  const length = 1 + Math.floor(next() * max);
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[Math.floor(next() * ALPHABET.length)] ?? "a";
  return out;
}

/** Names that matter to the rules: dots, underscores, node_modules, index names, odd characters. */
const SEGMENTS = [
  "a",
  "guides",
  "Getting Started",
  "Git & Dev Tools",
  "what's new",
  "Café",
  "日本語",
  ".git",
  ".github",
  ".obsidian",
  "_private",
  "_",
  "__init__",
  "my_file",
  "my-file",
  "a.b",
  "x._y",
  "node_modules",
  "node_modules_extra",
  "Node_Modules",
  "..hidden",
  "...",
  "-",
  "---",
  "&",
  "100%",
  "a b",
];

const FILES = [
  "README.md",
  "readme.md",
  "Readme.md",
  "index.md",
  "INDEX.MD",
  "Index.markdown",
  "README",
  "index.md.bak",
  "readme-first.md",
  "README.txt",
  "_README.md",
  ".README.md",
  "a.md",
  "A B.md",
  "Install Steps.md",
  "x.y.md",
  "_draft.md",
  ".hidden.md",
  "notes.md",
  "Café.md",
  "日本語.md",
];

function paths(): string[] {
  const out = new Set<string>(FILES);
  for (const dir of SEGMENTS) {
    for (const file of FILES) {
      out.add(`${dir}/${file}`);
      out.add(`a/${dir}/${file}`);
      out.add(`${dir}/${dir}/${file}`);
    }
    out.add(`${dir}.md`);
  }
  const next = random(20261006);
  for (let i = 0; i < 1500; i++) {
    const depth = Math.floor(next() * 4);
    const parts: string[] = [];
    for (let d = 0; d < depth; d++) {
      parts.push(
        next() < 0.5
          ? (SEGMENTS[Math.floor(next() * SEGMENTS.length)] ?? "a")
          : randomText(next, 8),
      );
    }
    // The generated text has no "/" in it: it is one segment.
    const file =
      next() < 0.4
        ? (FILES[Math.floor(next() * FILES.length)] ?? "a.md")
        : `${randomText(next, 10)}.md`;
    out.add([...parts.map((p) => p.replaceAll("/", "-")), file.replaceAll("/", "-")].join("/"));
  }
  return [...out].filter(
    (path) => !path.split("/").some((part) => part === "" || part === "." || part === ".."),
  );
}

const dirOf = (path: string): string =>
  path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
const nameOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
const stemOf = (path: string): string => path.replace(/\.[^./]+$/, "");

// ---- tests -------------------------------------------------------------------------------------

describe("the rules mirror Jx's", () => {
  test("which files the `exclude` globs of the docs content type leave out", () => {
    const matcher = jx.rules.compileExclude(rules.exclude);
    const disagreements: string[] = [];
    let compared = 0;
    for (const path of paths()) {
      // Jx asks about files; docs.ts asks about every path of a walk, so a file is the comparison.
      const theirs = matcher.excludedBy(path) !== undefined;
      compared++;
      if (isExcluded(path) !== theirs) {
        disagreements.push(`${path}: docusystem ${!theirs}, Jx ${theirs}`);
      }
    }
    expect(compared).toBeGreaterThan(1500);
    expect(disagreements).toEqual([]);
  });

  test("which pages the `where` clause publishes", () => {
    const where = jx.rules.compileWhere(rules.where);
    const values: unknown[] = [
      undefined,
      true,
      false,
      null,
      0,
      1,
      "",
      "true",
      "false",
      "yes",
      [true],
      [false],
      [true, false],
      ["true"],
      [],
      {},
      { a: true },
    ];
    const disagreements: string[] = [];
    for (const draft of values) {
      for (const publish of values) {
        const data: Record<string, unknown> = {};
        if (draft !== undefined) data.draft = draft;
        if (publish !== undefined) data.publish = publish;
        if (isPublished(data) !== where(data)) {
          disagreements.push(
            `draft ${JSON.stringify(draft)}, publish ${JSON.stringify(publish)}: ` +
              `docusystem ${isPublished(data)}, Jx ${where(data)}`,
          );
        }
      }
    }
    expect(disagreements).toEqual([]);
    expect(isPublished({ title: "x", order: 3, tags: ["draft"] })).toBe(where({ title: "x" }));
  });

  test("what a README or index file is", () => {
    const disagreements = paths()
      .map(nameOf)
      .filter((name) => isIndexName(name) !== jx.routes.isDirectoryIndex(name));
    expect(disagreements).toEqual([]);
  });

  test("the URL of every page", () => {
    const spec = jx.routes.parseRouteConfig(rules.route, rules.indexRoute, "docs");
    const disagreements: string[] = [];
    let routed = 0;
    for (const path of paths().filter((p) => /\.md$/i.test(p))) {
      const dir = dirOf(path);
      const name = nameOf(path);
      const rendered = jx.routes.renderRoute(spec, { id: stemOf(path), data: {}, path });
      // A name with no letter or digit in it cannot be routed by Jx at all; nav.ts then gives it the
      // address of its folder, where dedupe() keeps the folder's own page and warns.
      if ("error" in rendered) continue;
      routed++;
      const theirs = decodeURIComponent(jx.routes.routeHref(rendered.route, "always"));
      const ours = urlFor({ dir, base: name.replace(/\.[^.]+$/, ""), isIndex: isIndexName(name) });
      if (ours !== theirs) disagreements.push(`${path}: docusystem ${ours}, Jx ${theirs}`);
    }
    expect(routed).toBeGreaterThan(1000);
    expect(disagreements).toEqual([]);
  });

  test("slugs", () => {
    const next = random(1006);
    const texts = [
      ...SEGMENTS,
      ...FILES,
      "Git & Dev Tools",
      "C++ notes",
      "  --odd__name--  ",
      "ǅ",
      "İstanbul",
      "ΑΣ",
      ...Array.from({ length: 2000 }, () => randomText(next, 14)),
    ];
    const disagreements: string[] = [];
    for (const text of texts) {
      if (slugifySegment(text) !== jx.routes.slugifySegment(text)) {
        disagreements.push(`segment ${JSON.stringify(text)}`);
      }
      if (slugifyPath(text) !== jx.routes.slugifyPath(text)) {
        disagreements.push(`path ${JSON.stringify(text)}`);
      }
    }
    expect(disagreements).toEqual([]);
  });

  test("humanize never returns an empty label", () => {
    for (const text of [...SEGMENTS, ...FILES]) expect(humanize(text)).not.toBe("");
  });
});

describe("site/project.base.json", () => {
  test.skipIf(baseRules === null)(
    "carries the rules of the fixture (exclude, where, route, indexRoute)",
    () => {
      expect(baseRules).toMatchObject({
        exclude: fixtureRules.exclude,
        where: fixtureRules.where,
        route: fixtureRules.route,
        indexRoute: fixtureRules.indexRoute,
      });
    },
  );
});

test("the fixture is the starter's rules", () => {
  expect(fixtureRules.route).toBe("/docs/{id:slug}/");
  expect(fixtureRules.indexRoute).toBe("/docs/{dir:slug}/");
  expect(fixtureRules.exclude).toEqual([
    "**/node_modules/**",
    "**/.*",
    "**/.*/**",
    "**/_*",
    "**/_*/**",
  ]);
  expect(fixtureRules.where).toEqual({ draft: { $ne: true }, publish: { $ne: false } });
});
