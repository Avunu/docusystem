import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { generateProject, knownTokens, mergeJx, readBaseProject } from "../../src/lib/project.js";
import type { DocsConfig } from "../../src/lib/types.js";
import { tempDir, writeTree } from "../support/index.js";
import { CONFIG, SITE_SOURCE } from "./helpers.js";

const base = (): Record<string, any> => readBaseProject(SITE_SOURCE);
/** generateProject, with the project typed loosely so that the tests can look into it. */
const generateWith = (config: DocsConfig, o: Parameters<typeof generateProject>[1]) => {
  const result = generateProject(config, o);
  return { ...result, project: result.project as Record<string, any> };
};
const generate = (config: Partial<DocsConfig> = {}, strict = false) =>
  generateWith({ ...CONFIG, ...config }, { strict, base: base() });

describe("readBaseProject", () => {
  test("reads site/project.base.json of the folder it is given", () => {
    expect(base().name).toBe("Project Name");
    expect(Object.keys(base().content).sort()).toEqual(["config", "docs", "nav", "projects"]);
  });

  test("a missing, unparsable or non-object file is an error that names the file", () => {
    const missing = tempDir();
    expect(() => readBaseProject(missing)).toThrow(join(missing, "project.base.json"));
    const broken = tempDir();
    writeTree(broken, { "project.base.json": "{ nope" });
    expect(() => readBaseProject(broken)).toThrow(/project\.base\.json/);
    const array = tempDir();
    writeTree(array, { "project.base.json": "[]" });
    expect(() => readBaseProject(array)).toThrow(/not a JSON object/);
  });
});

describe("knownTokens", () => {
  test("light are the style keys that start with --, dark the keys of style['@--dark']", () => {
    const known = knownTokens(base());
    expect([...known.light].sort()).toEqual([
      "--color-action",
      "--color-bg",
      "--color-on-action",
      "--color-text",
    ]);
    expect([...known.dark].sort()).toEqual(["--color-action", "--color-bg", "--color-text"]);
  });

  test("a base without style has no tokens", () => {
    expect(knownTokens({})).toEqual({ light: new Set(), dark: new Set() });
    expect(knownTokens({ style: { "--a": "1" } })).toEqual({
      light: new Set(["--a"]),
      dark: new Set(),
    });
  });
});

describe("generateProject", () => {
  test("is the base with the identity written in, without $schema and $comment", () => {
    const { project, errors, warnings } = generate();
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
    expect(project.name).toBe("Example");
    expect(project.url).toBe("https://example.avunu.net");
    expect(project).not.toHaveProperty("$schema");
    expect(project).not.toHaveProperty("$comment");
    const expected = base();
    delete expected.$schema;
    delete expected.$comment;
    expected.name = "Example";
    expected.url = "https://example.avunu.net";
    expect(project).toEqual(expected);
    expect(Object.keys(project)).toEqual(Object.keys(expected)); // the base's order
  });

  test("does not change the base it was given", () => {
    const original = base();
    const copy = structuredClone(original);
    generateProject(
      { ...CONFIG, images: "off", theme: { light: { "--color-bg": "#fff" } }, jx: { build: null } },
      { strict: true, base: original },
    );
    expect(original).toEqual(copy);
  });

  test("links follows the strictness: error when strict, warn otherwise", () => {
    expect(generate({}, true).project.content.docs.links).toBe("error");
    expect(generate({}, false).project.content.docs.links).toBe("warn");
  });

  test("the other content types are untouched", () => {
    const { project } = generate({}, true);
    const expected = base().content;
    expect(project.content.nav).toEqual(expected.nav);
    expect(project.content.config).toEqual(expected.config);
    expect(project.content.projects).toEqual(expected.projects);
    expect({ ...project.content.docs, links: "warn" }).toEqual(expected.docs);
  });

  test("a base without a docs content type gets no links setting", () => {
    const { project } = generateWith(CONFIG, { strict: true, base: { name: "x", content: {} } });
    expect(project.content).toEqual({});
  });

  test("images: off turns optimization off; optimize leaves the project alone", () => {
    expect(generate({ images: "off" }).project.images).toEqual({ optimize: false });
    expect(generate({ images: "optimize" }).project).not.toHaveProperty("images");
    expect(generate({}).project).not.toHaveProperty("images");
  });

  describe("theme", () => {
    test("overrides light tokens and dark tokens separately", () => {
      const { project, errors } = generate({
        theme: {
          light: { "--color-action": "#4B2A99" },
          dark: { "--color-action": "#CBB8FF", "--color-bg": "#000000" },
        },
      });
      expect(errors).toEqual([]);
      expect(project.style["--color-action"]).toBe("#4B2A99");
      expect(project.style["@--dark"]["--color-action"]).toBe("#CBB8FF");
      expect(project.style["@--dark"]["--color-bg"]).toBe("#000000");
      // What was not named is as it was.
      expect(project.style["--color-bg"]).toBe("#FBF8F3");
      expect(project.style["@--dark"]["--color-text"]).toBe("#EEEBF4");
    });

    test("a token the package does not define is an error that names it, and is not written", () => {
      const { project, errors } = generate({
        theme: {
          light: { "--nope": "1px", "--color-bg": "#fff" },
          dark: { "--also-nope": "red" },
        },
      });
      expect(errors).toEqual([
        'theme.light: "--nope" is not a design token of this version',
        'theme.dark: "--also-nope" is not a design token that this version re-declares for dark mode',
      ]);
      expect(project.style).not.toHaveProperty("--nope");
      expect(project.style["@--dark"]).not.toHaveProperty("--also-nope");
      expect(project.style["--color-bg"]).toBe("#fff"); // the valid one still applies
    });

    test("a light-only token cannot be overridden for dark", () => {
      const { errors } = generate({ theme: { dark: { "--color-on-action": "#000" } } });
      expect(errors).toEqual([
        'theme.dark: "--color-on-action" is not a design token that this version re-declares for dark mode',
      ]);
    });

    test("names that are not tokens at all are errors, whatever they look like", () => {
      const { errors, project } = generate({
        theme: {
          light: JSON.parse('{"__proto__": "x", "constructor": "y", "--color-bg": "#111"}'),
        },
      });
      expect(errors.length).toBeGreaterThan(0);
      expect(({} as Record<string, unknown>).x).toBeUndefined();
      expect(project.style["--color-bg"]).toBe("#111");
    });

    test.each([
      ["a semicolon", "red; background: url(//evil)"],
      ["a brace", "red } body { display: none"],
      ["a closing tag", "</style><script>"],
      ["an angle bracket", "a<b"],
      ["a backslash", "\\41"],
      ["url(", "url(//evil.example/x.png)"],
      ["a spaced URL( in any case", "URL (x)"],
      ["@import", "@import 'x'"],
      ["more than 200 characters", "a".repeat(201)],
    ])("a value with %s is refused", (_what, value) => {
      const { project, errors } = generate({ theme: { light: { "--color-bg": value } } });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(/^theme\.light: the value of "--color-bg" cannot be used: /);
      expect(project.style["--color-bg"]).toBe("#FBF8F3");
    });

    test("a value that is not a string is refused", () => {
      const { errors } = generate({ theme: { dark: { "--color-bg": 5 as never } } });
      expect(errors).toEqual([
        'theme.dark: the value of "--color-bg" cannot be used: it is not a string',
      ]);
    });

    test("plain CSS values pass: colours, lengths, functions, custom font stacks", () => {
      const values = [
        "#4B2A99",
        "rgb(10 20 30 / 50%)",
        "color-mix(in srgb, var(--color-bg) 22%, transparent)",
        "clamp(28px, 3vw, 34px)",
        "'Figtree', ui-sans-serif, system-ui",
        "0 8px 24px rgba(24, 29, 23, 0.08)",
      ];
      for (const value of values) {
        expect(generate({ theme: { light: { "--color-bg": value } } }).errors, value).toEqual([]);
      }
    });

    test("a base without any tokens refuses every override", () => {
      const { errors } = generateProject(
        { ...CONFIG, theme: { light: { "--a": "1" }, dark: { "--a": "1" } } },
        { strict: false, base: { name: "x" } },
      );
      expect(errors).toHaveLength(2);
    });
  });

  describe("the jx fragment", () => {
    test("is applied after the theme and images, and merges", () => {
      const { project, errors, warnings } = generate({
        images: "off",
        theme: { light: { "--color-bg": "#111111" } },
        jx: {
          images: { quality: 70 },
          style: { "--color-bg": "#222222" },
          build: { trailingSlash: "never" },
        },
      });
      expect(errors).toEqual([]);
      expect(warnings).toEqual([]);
      expect(project.images).toEqual({ optimize: false, quality: 70 });
      expect(project.style["--color-bg"]).toBe("#222222"); // the fragment is applied last
      expect(project.build).toEqual({
        outDir: "./dist",
        trailingSlash: "never",
        headers: { enabled: false },
      });
    });

    test("a fragment of nothing changes nothing", () => {
      expect(generate({ jx: {} }).project).toEqual(generate({}).project);
    });

    test("cannot loosen the link check: it follows the strictness, and says so", () => {
      const { project, warnings } = generate(
        { jx: { content: { docs: { links: "warn" } } } },
        true,
      );
      expect(project.content.docs.links).toBe("error");
      expect(warnings).toEqual([
        "overrides: jx.content.docs.links is ignored: the link check follows the strictness of the run (--strict, --lenient, CI)",
      ]);
      // And lenient runs cannot be made strict by it either.
      const lenient = generate({ jx: { content: { docs: { links: "error" } } } }, false);
      expect(lenient.project.content.docs.links).toBe("warn");
      expect(lenient.warnings).toHaveLength(1);
    });

    test("a fragment that sets the link check to what the run needs is not worth a warning", () => {
      expect(generate({ jx: { content: { docs: { links: "error" } } } }, true).warnings).toEqual(
        [],
      );
    });

    test("may replace the identity, but says so", () => {
      const { project, warnings } = generate({
        jx: {
          name: "Other",
          url: "https://other.example",
          content: { docs: { source: "./elsewhere" } },
        },
      });
      expect(project.name).toBe("Other");
      expect(project.url).toBe("https://other.example");
      expect(project.content.docs.source).toBe("./elsewhere");
      expect(warnings).toEqual([
        "overrides: jx.name replaces the project name: the name of the site comes from docusystem.config.json",
        "overrides: jx.url replaces the project URL: the address of the site comes from `domain` in docusystem.config.json",
        "overrides: jx.content.docs.source replaces the folder the Markdown is read from: the site will not show the staged documents",
      ]);
    });

    test("deleting the identity is also a replacement", () => {
      const { warnings } = generate({ jx: { name: null } });
      expect(warnings).toEqual([
        "overrides: jx.name replaces the project name: the name of the site comes from docusystem.config.json",
      ]);
    });

    test("deleting the docs content type does not invent one", () => {
      const { project } = generate({ jx: { content: { docs: null } } }, true);
      expect(project.content).not.toHaveProperty("docs");
    });
  });
});

describe("mergeJx", () => {
  const merge = (project: Record<string, unknown>, fragment: Record<string, unknown>) => {
    const warnings: string[] = [];
    return { merged: mergeJx(project, fragment, warnings), warnings };
  };

  test("objects merge key by key, to any depth", () => {
    const { merged, warnings } = merge(
      { a: { b: 1, c: { d: 2, e: 3 } }, f: 4 },
      { a: { c: { e: 30, g: 5 }, h: 6 }, i: 7 },
    );
    expect(merged).toEqual({ a: { b: 1, c: { d: 2, e: 30, g: 5 }, h: 6 }, f: 4, i: 7 });
    expect(warnings).toEqual([]);
  });

  test("null deletes a key, and deleting what is not there is nothing", () => {
    const { merged, warnings } = merge(
      { a: 1, b: { c: 2, d: 3 }, e: [1] },
      { a: null, b: { c: null }, missing: null, e: null },
    );
    expect(merged).toEqual({ b: { d: 3 } });
    expect(warnings).toEqual([]);
  });

  test("the array at $head is appended, the package's entries first", () => {
    const { merged, warnings } = merge({ $head: [{ n: 1 }, { n: 2 }] }, { $head: [{ n: 3 }] });
    expect(merged.$head).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    expect(warnings).toEqual([]);
  });

  test("$head is appended only at the top level; deeper it is an ordinary array", () => {
    const { merged, warnings } = merge({ x: { $head: [1, 2] } }, { x: { $head: [3] } });
    expect(merged).toEqual({ x: { $head: [3] } });
    expect(warnings).toEqual(["overrides: jx.x.$head replaces 2 entries of the package's list"]);
  });

  test("every other array replaces the package's, with a warning that counts and names the path", () => {
    const { merged, warnings } = merge(
      { extensions: ["a", "b"], content: { docs: { exclude: ["x", "y", "z"] } } },
      { extensions: ["c"], content: { docs: { exclude: [] } } },
    );
    expect(merged).toEqual({ extensions: ["c"], content: { docs: { exclude: [] } } });
    expect(warnings).toEqual([
      "overrides: jx.extensions replaces 2 entries of the package's list",
      "overrides: jx.content.docs.exclude replaces 3 entries of the package's list",
    ]);
  });

  test("a new array replaces nothing and warns of nothing; a scalar over an array is a replacement", () => {
    const { merged, warnings } = merge({ list: [1, 2] }, { fresh: [1], list: "none" });
    expect(merged).toEqual({ list: "none", fresh: [1] });
    expect(warnings).toEqual(["overrides: jx.list replaces 2 entries of the package's list"]);
  });

  test("an object replaces a scalar and a scalar replaces an object", () => {
    const { merged } = merge({ a: 1, b: { c: 2 } }, { a: { x: 1 }, b: "flat" });
    expect(merged).toEqual({ a: { x: 1 }, b: "flat" });
  });

  test("does not change its arguments and shares nothing with the fragment", () => {
    const project = { a: { b: [1] }, keep: { deep: 1 } };
    const fragment = { a: { c: { d: [1, 2] } } };
    const projectCopy = structuredClone(project);
    const fragmentCopy = structuredClone(fragment);
    const { merged } = merge(project, fragment);
    expect(project).toEqual(projectCopy);
    expect(fragment).toEqual(fragmentCopy);
    (merged.a as any).c.d.push(3);
    expect(fragment).toEqual(fragmentCopy);
  });

  test("a __proto__ key is ignored with a warning and pollutes nothing", () => {
    const fragment = JSON.parse(
      '{"__proto__": {"polluted": true}, "a": {"__proto__": {"deep": 1}}, "ok": 1}',
    );
    const { merged, warnings } = merge({ a: {} }, fragment);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).deep).toBeUndefined();
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
    expect(Object.keys(merged)).toEqual(["a", "ok"]);
    expect(warnings).toEqual([
      'overrides: jx.__proto__ is ignored: "__proto__" is not a setting',
      'overrides: jx.a.__proto__ is ignored: "__proto__" is not a setting',
    ]);
  });

  test("constructor and prototype keys are plain keys that reach nothing global", () => {
    const { merged } = merge(
      { a: 1 },
      JSON.parse('{"constructor": {"prototype": {"polluted": true}}}'),
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.keys(merged)).toEqual(["a", "constructor"]);
  });
});
