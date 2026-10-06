import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  CONFIG_FILE,
  CONFIG_KEYS,
  ConfigError,
  PLACEHOLDER_TAGLINE,
  RESERVED_KEYS,
  readConfig,
  validateConfig,
} from "../../src/lib/config.js";
import { tempDir } from "../support/index.js";
import { GOOD } from "./helpers.js";

const example = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures", "example.config.json"), "utf8"),
);

describe("validateConfig: what is accepted", () => {
  test("the seven identity keys (a slug may have underscores)", () => {
    expect(validateConfig(GOOD)).toEqual([]);
  });

  test("the example shell's configuration, with its $schema line", () => {
    expect(validateConfig(example)).toEqual([]);
  });

  test("every optional key", () => {
    expect(
      validateConfig({
        ...GOOD,
        $schema: "./node_modules/@avunu/docusystem/config.schema.json",
        branch: "18.0",
        docs: "../documentation",
        theme: { light: { "--color-action": "#4B2A99" }, dark: { "--color-action": "#CBB8FF" } },
        images: "off",
        jx: { $head: [{ tagName: "meta", attributes: { name: "robots", content: "noindex" } }] },
      }),
    ).toEqual([]);
  });

  test("a docs path with .. is a question for pathsFor, not for validateConfig", () => {
    expect(validateConfig({ ...GOOD, docs: "../../outside" })).toEqual([]);
  });
});

describe("validateConfig: what is refused", () => {
  test("anything but an object", () => {
    for (const raw of [null, undefined, [], "text", 5, true]) {
      expect(validateConfig(raw)).toHaveLength(1);
      expect(validateConfig(raw)[0]).toMatch(/must be a JSON object/);
    }
  });

  test("every missing key is reported at once", () => {
    expect(validateConfig({})).toEqual([
      '"name" is required',
      '"tagline" is required',
      '"slug" is required',
      '"platform" is required',
      '"repo" is required',
      '"domain" is required',
      '"license" is required',
    ]);
  });

  test("every wrong value is reported at once, with what it was", () => {
    const problems = validateConfig({
      name: "",
      tagline: 5,
      slug: "Bad Slug",
      platform: "windows",
      repo: "gitlab.com/x/y",
      domain: "https://x.avunu.net",
      license: null,
      branch: "a b",
      docs: "",
      images: "yes",
      jx: [],
      theme: [],
    });
    const text = problems.join("\n");
    expect(text).toContain('"name" must not be empty');
    expect(text).toContain('"tagline" must be a string (got 5)');
    expect(text).toContain('"slug" must be lowercase letters, digits, hyphens and underscores');
    expect(text).toContain('(got "Bad Slug")');
    expect(text).toContain(
      '"platform" must be one of frappe, odoo, wordpress, nixos, general (got "windows")',
    );
    expect(text).toContain(
      '"repo" must look like https://github.com/Avunu/project (got "gitlab.com/x/y")',
    );
    expect(text).toContain('"domain" must be a host name without a scheme');
    expect(text).toContain('"license" must be a string (got null)');
    expect(text).toContain('"branch" must be a plain branch name');
    expect(text).toContain('"docs" must be a folder path relative to docusystem.config.json');
    expect(text).toContain('"images" must be "optimize" or "off" (got "yes")');
    expect(text).toContain('"jx" must be an object (got an array)');
    expect(text).toContain('"theme" must be an object with "light" and "dark" (got an array)');
    expect(problems).toHaveLength(12);
  });

  test("a value is quoted shortened", () => {
    const [problem] = validateConfig({ ...GOOD, slug: `A${"x".repeat(200)}` });
    expect(problem).toContain("...");
    expect(problem?.length).toBeLessThan(250);
  });

  test("a blank text is empty", () => {
    expect(validateConfig({ ...GOOD, name: "   " })).toEqual(['"name" must not be empty']);
    expect(validateConfig({ ...GOOD, license: "\t" })).toEqual(['"license" must not be empty']);
  });

  test("the limits count characters, not UTF-16 units", () => {
    expect(validateConfig({ ...GOOD, name: "n".repeat(80) })).toEqual([]);
    expect(validateConfig({ ...GOOD, name: "n".repeat(81) })).toEqual([
      '"name" is too long: 80 characters at most (it has 81)',
    ]);
    expect(validateConfig({ ...GOOD, license: "l".repeat(81) })).toHaveLength(1);
    expect(validateConfig({ ...GOOD, tagline: "t".repeat(200) })).toEqual([]);
    expect(validateConfig({ ...GOOD, tagline: "t".repeat(201) })).toEqual([
      '"tagline" should be one sentence of 200 characters at most (it has 201)',
    ]);
    // 100 emoji are 200 UTF-16 units and 100 characters.
    expect(validateConfig({ ...GOOD, tagline: "😀".repeat(100) })).toEqual([]);
    expect(validateConfig({ ...GOOD, name: "😀".repeat(80) })).toEqual([]);
    expect(validateConfig({ ...GOOD, name: "😀".repeat(81) })).toHaveLength(1);
  });

  // Jx evaluates every string that holds `${` as JavaScript when the site is built, and the text keys
  // reach the pages (the header, the footer, the page titles, the links).
  test.each(["name", "tagline", "license", "docs"])(
    "%s with a `${...}` is refused before anything is built",
    (key) => {
      const problems = validateConfig({ ...GOOD, [key]: "Safe ${process.cwd()}" });
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain(`"${key}" must not contain \${...}`);
      // what happens to the text: the three text keys are run, the folder name reaches the links
      expect(problems[0]).toContain(key === "docs" ? "links" : "JavaScript");
    },
  );

  test("a `$` or a `{` alone is fine in a text key", () => {
    expect(
      validateConfig({ ...GOOD, name: "Costs $5 {beta}", tagline: "Fast $ { } sync." }),
    ).toEqual([]);
  });

  test("the placeholder tagline of the older tools", () => {
    expect(validateConfig({ ...GOOD, tagline: PLACEHOLDER_TAGLINE })).toEqual([
      '"tagline" is still the placeholder text: say in one sentence what the project does',
    ]);
  });

  test.each([
    ["an absolute path", "/srv/docs"],
    ["a Windows drive", "C:\\docs"],
    ["a UNC path", "\\\\server\\docs"],
  ])("docs as %s", (_label, docs) => {
    const [problem] = validateConfig({ ...GOOD, docs });
    expect(problem).toContain("not an absolute path");
  });

  test("docs with a NUL character", () => {
    expect(validateConfig({ ...GOOD, docs: "../do\0cs" })[0]).toContain("NUL");
  });

  test("a non-string $schema", () => {
    expect(validateConfig({ ...GOOD, $schema: 3 })).toEqual(['"$schema" must be a string (got 3)']);
  });
});

describe("validateConfig: unknown keys", () => {
  test("a typo gets a did-you-mean", () => {
    expect(validateConfig({ ...GOOD, tagLine: "x" })).toEqual([
      '"tagLine" is not a docusystem setting; did you mean "tagline"?',
    ]);
  });

  test.each([
    ["taglin", "tagline"],
    ["licence", "license"],
    ["domains", "domain"],
    ["Repo", "repo"],
    ["NAME", "name"],
    ["platfrom", "platform"],
    ["brach", "branch"],
    ["image", "images"],
    ["thme", "theme"],
    ["Jx", "jx"],
    ["$Schema", "$schema"],
  ])("%s is probably %s", (typo, key) => {
    const problems = validateConfig({ ...GOOD, [typo]: "x" });
    expect(problems).toEqual([`"${typo}" is not a docusystem setting; did you mean "${key}"?`]);
  });

  test("a key that is nothing like a setting has no suggestion", () => {
    expect(validateConfig({ ...GOOD, wibble: 1 })).toEqual([
      '"wibble" is not a docusystem setting',
    ]);
  });

  test("the names kept for later releases are refused, and say why", () => {
    for (const key of RESERVED_KEYS) {
      const [problem, ...rest] = validateConfig({ ...GOOD, [key]: {} });
      expect(rest).toEqual([]);
      expect(problem).toBe(
        `"${key}" is not a docusystem setting yet: the name is reserved for a later release (remove it)`,
      );
    }
  });

  test("the accepted keys are the schema's and none of the reserved ones", () => {
    expect(CONFIG_KEYS).toHaveLength(13);
    for (const key of RESERVED_KEYS) expect(CONFIG_KEYS).not.toContain(key);
  });

  test("a typo of a required key is reported with the missing key", () => {
    const { tagline: _tagline, ...rest } = GOOD;
    expect(validateConfig({ ...rest, tagLine: "x" })).toEqual([
      '"tagLine" is not a docusystem setting; did you mean "tagline"?',
      '"tagline" is required',
    ]);
  });

  test("a key named like an Object.prototype member is just unknown", () => {
    const raw = JSON.parse('{"__proto__": {"polluted": true}}');
    expect(validateConfig({ ...GOOD, ...raw })).toEqual([
      '"__proto__" is not a docusystem setting',
    ]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("validateConfig: theme", () => {
  const theme = (light: Record<string, unknown>, dark?: Record<string, unknown>) => ({
    ...GOOD,
    theme: { light, ...(dark === undefined ? {} : { dark }) },
  });

  test("plain CSS values are accepted", () => {
    for (const value of [
      "#4B2A99",
      "rgb(1 2 3 / 50%)",
      "color-mix(in srgb, var(--color-action) 22%, transparent)",
      '"Figtree", system-ui, sans-serif',
      "0 1px 2px rgba(0, 0, 0, 0.2)",
      "",
    ]) {
      expect(validateConfig(theme({ "--color-action": value }))).toEqual([]);
    }
  });

  test.each([
    ["a semicolon", "red; background: url(x)"],
    ["a closing brace", "red}"],
    ["an opening brace", "{red"],
    ["a less-than sign", "</style><script>"],
    ["a greater-than sign", "a > b"],
    ["a backslash", "\\72 ed"],
  ])("a value with %s is not plain CSS", (_label, value) => {
    expect(validateConfig(theme({ "--color-action": value }))).toEqual([
      '"theme.light": the value of --color-action is not plain CSS: it may not contain ; { } < > or a backslash',
    ]);
  });

  test.each([
    "url(https://example.org/x.png)",
    "URL(x)",
    "image-set(x 1x)",
    "-webkit-image-set(x)",
    "src(x)",
    "@import x",
    "@IMPORT x",
  ])("a value that loads a resource: %s", (value) => {
    expect(validateConfig(theme({ "--color-action": value }))).toEqual([
      '"theme.light": the value of --color-action may not load a resource: no url(), src(), image-set() or @import',
    ]);
  });

  test("a value of 200 characters is the longest", () => {
    expect(validateConfig(theme({ "--x": "a".repeat(200) }))).toEqual([]);
    expect(validateConfig(theme({ "--x": "a".repeat(201) }))).toEqual([
      '"theme.light": the value of --x is too long: 200 characters at most',
    ]);
  });

  test("a value that is not a string", () => {
    expect(validateConfig(theme({ "--x": 5 }))).toEqual([
      '"theme.light": the value of --x must be a string (got 5)',
    ]);
  });

  test.each(["color", "--Color", "-color", "--", "--1x", "--a b", "--a;b"])(
    "%s is not a custom property name",
    (token) => {
      const [problem, ...rest] = validateConfig(theme({}, { [token]: "red" }));
      expect(rest).toEqual([]);
      expect(problem).toContain('"theme.dark"');
      expect(problem).toContain("is not a custom property name");
    },
  );

  test("only light and dark exist", () => {
    expect(validateConfig({ ...GOOD, theme: { light: {}, sepia: {} } })).toEqual([
      '"theme.sepia" is not a theme setting: use "theme.light" and "theme.dark"',
    ]);
    expect(validateConfig({ ...GOOD, theme: { dark: [] } })).toEqual([
      '"theme.dark" must be an object of CSS custom properties (got an array)',
    ]);
  });
});

describe("validateConfig: jx", () => {
  test("keys that reach Object.prototype are refused, wherever they are", () => {
    const jx = JSON.parse(
      '{"a": {"__proto__": {"x": 1}}, "b": [{"c": {"constructor": {"prototype": {}}}}], "$head": []}',
    );
    expect(validateConfig({ ...GOOD, jx })).toEqual([
      '"jx" may not contain the key "__proto__" (found at jx.a.__proto__)',
      '"jx" may not contain the key "constructor" (found at jx.b[0].c.constructor)',
    ]);
  });

  test("ordinary Jx fragments pass", () => {
    expect(
      validateConfig({
        ...GOOD,
        jx: { search: { enabled: false }, content: { docs: { links: null } }, $head: [] },
      }),
    ).toEqual([]);
  });
});

describe("readConfig", () => {
  const write = (dir: string, contents: string | object): void => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, CONFIG_FILE),
      typeof contents === "string" ? contents : JSON.stringify(contents),
    );
  };

  test("reads the keys as written, without $schema, and infers nothing", () => {
    const dir = tempDir();
    write(dir, { ...example });
    const config = readConfig(dir);
    expect(config).toEqual({
      name: "frappe-nix",
      tagline: example.tagline,
      slug: "frappe-nix",
      platform: "nixos",
      repo: "https://github.com/Avunu/frappe-nix",
      domain: "frappe-nix.avunu.net",
      license: "MIT",
    });
    expect("$schema" in config).toBe(false);
    expect("branch" in config).toBe(false);
    expect("docs" in config).toBe(false);
    expect("images" in config).toBe(false);
  });

  test("keeps the optional keys", () => {
    const dir = tempDir();
    const full = {
      ...GOOD,
      branch: "develop",
      docs: "../documentation",
      images: "off",
      theme: { light: { "--color-action": "#4B2A99" } },
      jx: { search: {} },
    };
    write(dir, full);
    expect(readConfig(dir)).toEqual(full);
  });

  test("a UTF-8 byte order mark is tolerated", () => {
    const dir = tempDir();
    write(dir, `\uFEFF${JSON.stringify(GOOD)}`);
    expect(readConfig(dir).slug).toBe("example_project");
  });

  test("a missing file says where it looked and what to do", () => {
    const dir = tempDir();
    expect(() => readConfig(dir)).toThrow(ConfigError);
    try {
      readConfig(dir);
    } catch (error) {
      const problems = (error as ConfigError).problems;
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain(join(dir, CONFIG_FILE));
      expect(problems[0]).toContain("docusystem init");
      expect(problems[0]).toContain("--site");
    }
  });

  test("a file that is not JSON", () => {
    const dir = tempDir();
    write(dir, "{ name: 'x' }");
    try {
      readConfig(dir);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).problems[0]).toMatch(
        /^docusystem\.config\.json is not valid JSON: /,
      );
    }
  });

  test("a file that is a folder cannot be read", () => {
    const dir = tempDir();
    mkdirSync(join(dir, CONFIG_FILE));
    try {
      readConfig(dir);
      expect.unreachable();
    } catch (error) {
      expect((error as ConfigError).problems[0]).toContain("cannot be read");
    }
  });

  test("every problem of the file comes at once, each starting with the file name", () => {
    const dir = tempDir();
    write(dir, {
      name: "",
      tagLine: "x",
      slug: "Bad",
      platform: "windows",
      repo: "x",
      domain: "y",
      license: "MIT",
    });
    try {
      readConfig(dir);
      expect.unreachable();
    } catch (error) {
      const { problems, message } = error as ConfigError;
      expect(problems.length).toBeGreaterThanOrEqual(7);
      for (const problem of problems) expect(problem.startsWith(`${CONFIG_FILE}: `)).toBe(true);
      expect(message).toBe(problems.join("\n"));
      expect(message).toContain('did you mean "tagline"?');
    }
  });

  test("a file that holds a list", () => {
    const dir = tempDir();
    write(dir, "[]");
    expect(() => readConfig(dir)).toThrow(/must be a JSON object/);
  });
});
