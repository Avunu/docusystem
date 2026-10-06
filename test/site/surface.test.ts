// The part of site/ that is semver surface (section 7.1): design-token names (a project's `theme`
// names them), the files under site/{components,layouts,pages,public}, the custom-element tags and
// the media-query names. fixtures/surface.json lists them as they are today. A removed or renamed
// entry is a MAJOR change and an added one is a MINOR change: either way this test fails until the
// list is edited in the same commit, so that no one changes the surface without meaning to.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { COMPONENTS, PROJECT, SITE_FIXTURES, readJson, siteFiles } from "./support/site.js";

const surface = JSON.parse(readFileSync(join(SITE_FIXTURES, "surface.json"), "utf8")) as {
  tokens: { light: string[]; dark: string[] };
  tags: string[];
  media: string[];
  files: string[];
};

const sorted = (values: Iterable<string>): string[] => [...values].sort();

describe("the semver surface of site/ is what fixtures/surface.json lists", () => {
  test("light design tokens (the `--` keys of the project's style)", () => {
    const light = Object.keys(PROJECT.style).filter((key) => key.startsWith("--"));
    expect(sorted(light)).toEqual(surface.tokens.light);
    expect(surface.tokens.light).toHaveLength(93);
  });

  test("dark design tokens (the keys of style[`@--dark`])", () => {
    expect(sorted(Object.keys(PROJECT.style["@--dark"]))).toEqual(surface.tokens.dark);
    expect(surface.tokens.dark).toHaveLength(47);
  });

  test("a dark token is also a light token, and the lists are sorted and free of repeats", () => {
    for (const list of [surface.tokens.light, surface.tokens.dark, surface.tags, surface.files]) {
      expect(list).toEqual(sorted(new Set(list)));
    }
    const light = new Set(surface.tokens.light);
    expect(surface.tokens.dark.filter((token) => !light.has(token))).toEqual([]);
  });

  test("custom-element tags", () => {
    expect(sorted(COMPONENTS.map((file) => readJson(file).tagName as string))).toEqual(
      surface.tags,
    );
  });

  test("media-query names", () => {
    expect(sorted(Object.keys(PROJECT.$media))).toEqual(surface.media);
  });

  test("files (everything of site/ but the bundled catalog)", () => {
    expect(siteFiles()).toEqual(surface.files);
  });
});
