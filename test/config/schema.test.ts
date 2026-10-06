// config.schema.json is the editor's view of docusystem.config.json, validateConfig is the CLI's. They
// must not drift: the patterns, the limits, the keys and the platforms are compared with the code's, and
// a table of inputs must be accepted or refused by both alike (and by what the validator adds on top,
// on purpose, only the second one).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, test } from "vitest";
import {
  BRANCH,
  CONFIG_KEYS,
  DOMAIN,
  LICENSE_MAX,
  NAME_MAX,
  OPTIONAL_KEYS,
  REPO,
  REQUIRED_KEYS,
  SLUG,
  TAGLINE_MAX,
  TOKEN_NAME,
  TOKEN_VALUE,
  TOKEN_VALUE_MAX,
  validateConfig,
} from "../../src/lib/config.js";
import { packageRoot } from "../../src/lib/package-info.js";
import { PLATFORMS } from "../../src/lib/platforms.js";
import { GOOD } from "./helpers.js";

type Json = Record<string, any>;

const schema: Json = JSON.parse(readFileSync(join(packageRoot, "config.schema.json"), "utf8"));
const example: Json = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures", "example.config.json"), "utf8"),
);

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validate = ajv.compile(schema);
const schemaAccepts = (input: unknown): boolean => validate(input) === true;

describe("config.schema.json", () => {
  test("is a strict draft 2020-12 schema that names the package's file", () => {
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.$id).toBe(
      "https://raw.githubusercontent.com/Avunu/docusystem/main/config.schema.json",
    );
    expect(schema.additionalProperties).toBe(false);
  });

  test("accepts the example shell's configuration", () => {
    expect(schemaAccepts(example)).toBe(true);
    expect(validate.errors).toBeNull();
  });

  test("is shipped and exported under its own name", () => {
    const manifest: Json = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
    expect(manifest.exports["./config.schema.json"]).toBe("./config.schema.json");
    expect(manifest.files).toContain("config.schema.json");
  });

  test("every property carries a description (the editor shows it)", () => {
    for (const [key, value] of Object.entries(schema.properties as Json)) {
      if (key === "$schema") continue;
      expect(typeof value.description, key).toBe("string");
    }
  });
});

describe("the schema and the validator say the same thing", () => {
  test("the keys: seven required, five optional, and $schema", () => {
    expect(schema.required).toEqual([...REQUIRED_KEYS]);
    expect(Object.keys(schema.properties)).toEqual([...CONFIG_KEYS]);
    expect(CONFIG_KEYS).toEqual(["$schema", ...REQUIRED_KEYS, ...OPTIONAL_KEYS]);
  });

  test("the platforms are the PLATFORMS", () => {
    expect(schema.properties.platform.enum).toEqual([...PLATFORMS]);
  });

  test("images", () => {
    expect(schema.properties.images.enum).toEqual(["optimize", "off"]);
    expect(schema.properties.images.default).toBe("optimize");
  });

  test("the patterns are the code's (RegExp normalizes how a slash is written)", () => {
    const same = (pattern: string, regexp: RegExp): void => {
      expect(new RegExp(pattern).source).toBe(regexp.source);
    };
    same(schema.properties.slug.pattern, SLUG);
    same(schema.properties.repo.pattern, REPO);
    same(schema.properties.domain.pattern, DOMAIN);
    same(schema.properties.branch.pattern, BRANCH);
    same(schema.$defs.tokens.propertyNames.pattern, TOKEN_NAME);
    same(schema.$defs.tokens.additionalProperties.pattern, TOKEN_VALUE);
  });

  test("the limits are the code's", () => {
    expect(schema.properties.name.maxLength).toBe(NAME_MAX);
    expect(schema.properties.tagline.maxLength).toBe(TAGLINE_MAX);
    expect(schema.properties.license.maxLength).toBe(LICENSE_MAX);
    expect(schema.$defs.tokens.additionalProperties.maxLength).toBe(TOKEN_VALUE_MAX);
    for (const key of ["name", "tagline", "license", "docs"]) {
      expect(schema.properties[key].minLength, key).toBe(1);
    }
  });

  test("the theme has exactly light and dark", () => {
    expect(Object.keys(schema.properties.theme.properties)).toEqual(["light", "dark"]);
    expect(schema.properties.theme.additionalProperties).toBe(false);
  });

  // [label, the configuration, whether it is valid]. Both must answer the same.
  const base = GOOD as unknown as Json;
  const without = (key: string): Json => {
    const { [key]: _removed, ...rest } = base;
    return rest;
  };
  const CASES: Array<[string, unknown, boolean]> = [
    ["the seven keys", base, true],
    ["the example shell", example, true],
    ["a slug with underscores", { ...base, slug: "erpnext_taskview" }, true],
    ["a one-letter slug", { ...base, slug: "x" }, true],
    ["a slug that starts with a digit", { ...base, slug: "9lives" }, true],
    [
      "all optional keys",
      {
        ...base,
        branch: "release/18.0",
        docs: "docs",
        images: "off",
        theme: { light: { "--a": "red" }, dark: {} },
        jx: {},
      },
      true,
    ],
    ["a branch with a dot and a slash", { ...base, branch: "release/18.0" }, true],
    ["a repo ending in .git", { ...base, repo: "https://github.com/Avunu/x.git" }, true],
    ["a domain with a deep sub-domain", { ...base, domain: "a.b.example.org" }, true],
    ["name missing", without("name"), false],
    ["tagline missing", without("tagline"), false],
    ["slug missing", without("slug"), false],
    ["platform missing", without("platform"), false],
    ["repo missing", without("repo"), false],
    ["domain missing", without("domain"), false],
    ["license missing", without("license"), false],
    ["an empty name", { ...base, name: "" }, false],
    ["a name of 81 characters", { ...base, name: "n".repeat(81) }, false],
    ["a name that is a number", { ...base, name: 5 }, false],
    ["a tagline of 201 characters", { ...base, tagline: "t".repeat(201) }, false],
    ["an upper-case slug", { ...base, slug: "Example" }, false],
    ["a slug with a space", { ...base, slug: "my project" }, false],
    ["a slug that starts with a hyphen", { ...base, slug: "-x" }, false],
    ["a slug that starts with an underscore", { ...base, slug: "_x" }, false],
    ["an unknown platform", { ...base, platform: "windows" }, false],
    ["a platform in the wrong case", { ...base, platform: "Frappe" }, false],
    ["a repo on another host", { ...base, repo: "https://gitlab.com/Avunu/x" }, false],
    ["a repo with http", { ...base, repo: "http://github.com/Avunu/x" }, false],
    ["a repo with a trailing slash", { ...base, repo: "https://github.com/Avunu/x/" }, false],
    ["a repo with a path", { ...base, repo: "https://github.com/Avunu/x/tree/main" }, false],
    ["a domain with a scheme", { ...base, domain: "https://x.avunu.net" }, false],
    ["a domain in upper case", { ...base, domain: "X.avunu.net" }, false],
    ["a domain with an underscore", { ...base, domain: "my_project.avunu.net" }, false],
    ["a domain of one label", { ...base, domain: "localhost" }, false],
    ["a domain with a trailing dot", { ...base, domain: "x.avunu.net." }, false],
    ["a branch with a space", { ...base, branch: "a b" }, false],
    ["a branch with ..", { ...base, branch: "a..b" }, false],
    ["a branch that starts with a hyphen", { ...base, branch: "-x" }, false],
    ["a branch of 101 characters", { ...base, branch: "b".repeat(101) }, false],
    ["an empty docs", { ...base, docs: "" }, false],
    ["a docs that is a number", { ...base, docs: 3 }, false],
    ["an unknown images value", { ...base, images: "yes" }, false],
    ["jx as a list", { ...base, jx: [] }, false],
    ["jx as null", { ...base, jx: null }, false],
    ["an unknown key", { ...base, tagLine: "x" }, false],
    ["a reserved key", { ...base, footer: {} }, false],
    ["a $schema that is not a string", { ...base, $schema: 1 }, false],
    ["theme as a list", { ...base, theme: [] }, false],
    ["a theme with another mode", { ...base, theme: { sepia: {} } }, false],
    ["a token name without --", { ...base, theme: { light: { color: "red" } } }, false],
    ["a token name in upper case", { ...base, theme: { light: { "--Color": "red" } } }, false],
    [
      "a token value with a semicolon",
      { ...base, theme: { light: { "--a": "red; x: y" } } },
      false,
    ],
    ["a token value with a brace", { ...base, theme: { dark: { "--a": "red}" } } }, false],
    [
      "a token value with an angle bracket",
      { ...base, theme: { dark: { "--a": "</style>" } } },
      false,
    ],
    ["a token value with a backslash", { ...base, theme: { dark: { "--a": "\\72ed" } } }, false],
    [
      "a token value of 201 characters",
      { ...base, theme: { light: { "--a": "a".repeat(201) } } },
      false,
    ],
    ["a token value that is a number", { ...base, theme: { light: { "--a": 1 } } }, false],
  ];

  test("the table has at least 30 inputs", () => {
    expect(CASES.length).toBeGreaterThanOrEqual(30);
  });

  test.each(CASES)("%s", (_label, input, valid) => {
    expect(schemaAccepts(input)).toBe(valid);
    expect(validateConfig(input).length === 0).toBe(valid);
  });

  // What validateConfig refuses and the schema lets through: stricter on purpose (see its comment).
  test.each([
    ["a name of spaces", { ...base, name: "  " }],
    ["an absolute docs", { ...base, docs: "/srv/docs" }],
    ["a token value that loads a resource", { ...base, theme: { light: { "--a": "url(x)" } } }],
    ["a token value with @import", { ...base, theme: { light: { "--a": "@import x" } } }],
    [
      "the placeholder tagline",
      { ...base, tagline: "One sentence that says what this project does and who it is for." },
    ],
    ["a jx key that reaches Object.prototype", { ...base, jx: JSON.parse('{"__proto__": {}}') }],
  ])("stricter than the schema: %s", (_label, input) => {
    expect(schemaAccepts(input)).toBe(true);
    expect(validateConfig(input).length).toBeGreaterThan(0);
  });
});
