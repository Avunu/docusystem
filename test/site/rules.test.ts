// The sidebar is computed by docs.ts and nav.ts (WP3) before Jx loads the same files, so the rules of
// the `docs` content type in project.base.json (exclude, where, route, indexRoute) exist twice. This
// is the agreement test of section 9.1 "site" and WP3's acceptance note: one table
// (support/fixtures.ts, DOC_FIXTURES) says what each file of the documentation fixture becomes, and
// all three parties are held to it: the table against the folder (always), Jx against the table
// (build.test.ts, always) and WP3's helpers against the table and the recorded nav.json (here, as
// soon as docs.ts and nav.ts are real code; until then the checks are skipped, see support/stubs.ts).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, test } from "vitest";
import { isExcluded, isPublished, readDocs, urlFor } from "../../src/lib/docs.js";
import { buildNav } from "../../src/lib/nav.js";
import type { NavData } from "../../src/lib/types.js";
import { DOCS_FIXTURE, DOC_FIXTURES, DOC_ROUTES, NAV_FIXTURE } from "./support/fixtures.js";
import { implemented } from "./support/stubs.js";

const walk = (dir = ""): string[] =>
  readdirSync(join(DOCS_FIXTURE, dir)).flatMap((name) => {
    const rel = dir ? `${dir}/${name}` : name;
    return statSync(join(DOCS_FIXTURE, rel)).isDirectory() ? walk(rel) : [rel];
  });

const frontMatter = (rel: string): Record<string, unknown> => {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(readFileSync(join(DOCS_FIXTURE, rel), "utf8"));
  return match ? (parse(match[1]!) as Record<string, unknown>) : {};
};

const fileParts = (rel: string) => {
  const slash = rel.lastIndexOf("/");
  const name = rel.slice(slash + 1);
  return {
    dir: slash === -1 ? "" : rel.slice(0, slash),
    base: name.replace(/\.[^.]+$/, ""),
    isIndex: /^(?:index|readme)\.md$/i.test(name),
  };
};

describe("the documentation fixture and its table", () => {
  test("the table lists every file of the fixture, and only those", () => {
    expect(DOC_FIXTURES.map((f) => f.file).sort()).toEqual(walk().sort());
  });

  test("a file the table leaves out says why in its own front matter or name", () => {
    for (const fixture of DOC_FIXTURES) {
      if (fixture.route !== undefined) continue;
      const data = frontMatter(fixture.file);
      const byName = fixture.file.split("/").some((part) => /^[._]/.test(part));
      expect(
        byName || data.draft === true || data.publish === false,
        `${fixture.file}: ${fixture.left}`,
      ).toBe(true);
    }
  });

  test("a published file is in the navigation recorded for the fixture, under its route", () => {
    const nav = JSON.parse(readFileSync(NAV_FIXTURE, "utf8")) as NavData;
    expect(Object.keys(nav.pages).sort()).toEqual(DOC_ROUTES);
    for (const fixture of DOC_FIXTURES) {
      if (fixture.route === undefined) continue;
      expect(nav.pages[fixture.route]?.edit, fixture.route).toBe(fixture.file);
    }
  });
});

describe.skipIf(!implemented(() => isExcluded("a.md")))(
  "docs.ts (WP3) applies the rules of the docs content type",
  () => {
    test("isExcluded: dot and underscore paths are out, whatever their depth", () => {
      for (const fixture of DOC_FIXTURES) {
        const byName = fixture.file.split("/").some((part) => /^[._]/.test(part));
        expect(isExcluded(fixture.file), fixture.file).toBe(byName);
      }
      expect(isExcluded("node_modules/pkg/README.md")).toBe(true);
      expect(isExcluded("a/node_modules/b.md")).toBe(true);
    });

    test("isPublished: draft: true and publish: false are out", () => {
      for (const fixture of DOC_FIXTURES) {
        const data = frontMatter(fixture.file);
        const out = data.draft === true || data.publish === false;
        expect(isPublished(data), fixture.file).toBe(!out);
      }
      expect(isPublished({ draft: false, publish: true })).toBe(true);
    });

    test("urlFor gives the route Jx gives: a slug of the path, the folder's page for README, readme and index", () => {
      for (const fixture of DOC_FIXTURES) {
        if (fixture.route === undefined) continue;
        expect(urlFor(fileParts(fixture.file)), fixture.file).toBe(fixture.route);
      }
    });

    test("readDocs reads exactly the published pages of the fixture", () => {
      const files = readDocs(DOCS_FIXTURE);
      expect(files.map((f) => f.rel).sort()).toEqual(
        DOC_FIXTURES.filter((f) => f.route !== undefined)
          .map((f) => f.file)
          .sort(),
      );
      expect(files.map((f) => urlFor(f)).sort()).toEqual(DOC_ROUTES);
    });
  },
);

describe.skipIf(!implemented(() => buildNav([], "x")))(
  "nav.ts (WP3) produces the sidebar data the layouts read",
  () => {
    test("buildNav over the fixture equals the nav.json recorded for it (what build.test.ts feeds Jx)", () => {
      const recorded = JSON.parse(readFileSync(NAV_FIXTURE, "utf8")) as NavData;
      const { nav, warnings } = buildNav(readDocs(DOCS_FIXTURE), "Example Project");
      expect(warnings).toEqual([]);
      expect(JSON.parse(JSON.stringify(nav))).toEqual(recorded);
    });
  },
);
