import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  PAIRS,
  contrastFailures,
  contrastOfRoot,
  formatFailure,
  highlightOf,
  parseColor,
  ratio,
  themes,
} from "../../src/lib/contrast.js";
import { REPO_ROOT, tempDir, writeTree } from "../support/index.js";
import { OUTPUT_FIXTURES } from "./helpers.js";

type Style = Record<string, unknown> & { "@--dark": Record<string, string> };

/** The design tokens of the Avunu theme and the search highlight rule, as the package ships them. */
const FIXTURE_ROOT = join(OUTPUT_FIXTURES, "contrast", "root");
const json = (file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
const tokens = (): Style =>
  structuredClone(json(join(FIXTURE_ROOT, "project.json")).style) as Style;
const searchRule = (): Record<string, unknown> =>
  (json(join(FIXTURE_ROOT, "components", "docs-search.json")).style as Record<string, unknown>)[
    "& .hl"
  ] as Record<string, unknown>;
const highlight = () => highlightOf(searchRule());

describe("the tokens of the theme", () => {
  test("the pairs that are listed, and the search highlight read from its component, meet WCAG AA in both themes", () => {
    expect(highlight()).toEqual({ token: "--color-action", percent: 22, text: ["--color-text"] });
    const { checked, failures } = contrastFailures(tokens(), highlight());
    expect(failures).toEqual([]);
    expect(checked).toBe(148);
  });

  test("the 148 are the 80 pairs in the light theme, 64 in the dark one (the night tokens are the same in both) and the highlight", () => {
    expect(PAIRS).toHaveLength(80);
    expect(PAIRS.filter(([, , , label]) => label.startsWith("night "))).toHaveLength(16);
    const withoutHighlight = contrastFailures(tokens(), null);
    expect(withoutHighlight.checked).toBe(80 + 64);
    // The highlight sits on two surfaces in each of the two themes, behind the one text colour of its rule.
    expect(contrastFailures(tokens(), highlight()).checked - withoutHighlight.checked).toBe(2 * 2);
  });

  test("every token the pairs name exists in the light theme or is re-declared dark", () => {
    const { light } = themes(tokens());
    const names = new Set(PAIRS.flatMap(([fg, bg]) => [fg, bg]));
    expect([...names].filter((name) => light[name] === undefined)).toEqual([]);
  });

  test("a project.json root is read the way the pipeline reads it", () => {
    expect(contrastOfRoot(FIXTURE_ROOT)).toEqual(contrastFailures(tokens(), highlight()));
  });
});

describe("a theme that breaks contrast", () => {
  test("--color-action: #C9B8FF fails the primary button at 1.78:1 in the light theme, and only there", () => {
    const style = tokens();
    style["--color-action"] = "#C9B8FF";
    const { failures } = contrastFailures(style, highlight());
    expect(failures).toContainEqual({
      theme: "light",
      label: "primary button",
      ratio: 1.78,
      minimum: 4.5,
    });
    expect(failures.every((f) => f.theme === "light")).toBe(true);
    expect(formatFailure(failures.find((f) => f.label === "primary button")!)).toBe(
      "light: primary button is 1.78:1, needs 4.5:1",
    );
  });

  test("--color-action: #4B2A99 passes everything", () => {
    const style = tokens();
    style["--color-action"] = "#4B2A99";
    const { checked, failures } = contrastFailures(style, highlight());
    expect(failures).toEqual([]);
    expect(checked).toBe(148);
  });

  test("a dark-theme override is judged against the dark theme", () => {
    const style = tokens();
    style["@--dark"]["--color-text"] = "#3A3A3A";
    const { failures } = contrastFailures(style, highlight());
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.every((f) => f.theme === "dark")).toBe(true);
    expect(failures.map((f) => f.label)).toContain("text on --color-bg");
  });

  test("a weak highlight fails, and the highlight as it was shipped first (inherited text colour) fails on the caption", () => {
    const strong = contrastFailures(tokens(), {
      token: "--color-action",
      percent: 100,
      text: ["--color-text"],
    });
    expect(strong.failures.some((f) => f.label.startsWith("search highlight"))).toBe(true);
    const inherited = highlightOf({
      backgroundColor: "color-mix(in srgb, var(--color-action) 22%, transparent)",
      color: "inherit",
    });
    expect(inherited?.text).toEqual(["--color-text", "--color-text-caption"]);
    expect(
      contrastFailures(tokens(), inherited).failures.some((f) => f.label.includes("caption")),
    ).toBe(true);
  });

  test("highlightOf reads color-mix rules only", () => {
    expect(highlightOf({ backgroundColor: "#ff0000" })).toBeNull();
    expect(highlightOf(undefined)).toBeNull();
    expect(highlightOf({})).toBeNull();
    expect(
      highlightOf({
        backgroundColor: "color-mix(in srgb, var(--color-action) 22.5%, transparent)",
        color: "var(--color-text)",
      }),
    ).toEqual({
      token: "--color-action",
      percent: 22.5,
      text: ["--color-text"],
    });
  });
});

describe("tokens the gate cannot measure are failures, never exceptions", () => {
  const failuresOf = (
    name: string,
    value: string | undefined,
    theme: "light" | "dark" = "light",
  ) => {
    const style = tokens();
    const target = theme === "light" ? style : style["@--dark"];
    if (value === undefined) delete target[name];
    else target[name] = value;
    return contrastFailures(style, highlight());
  };

  test("a colour name is not read, and the message says how to write it", () => {
    const { failures } = failuresOf("--color-action", "rebeccapurple");
    const unreadable = failures.filter((f) => f.ratio === 0);
    expect(unreadable.length).toBeGreaterThan(0);
    expect(unreadable.every((f) => f.theme === "light")).toBe(true);
    expect(formatFailure(unreadable[0]!)).toMatch(
      /^light: .*"rebeccapurple" is not a colour the check can read \(write it as #rrggbb, rgb\(\) or hsl\(\)\)$/,
    );
  });

  test("a missing token fails every pair that uses it, in the theme that lacks it", () => {
    const { failures } = failuresOf("--color-focus", undefined);
    expect(
      failures
        .filter((f) => f.theme === "light")
        .every((f) => f.ratio === 0 && f.label.includes("--color-focus is not defined")),
    ).toBe(true);
    expect(failures.filter((f) => f.theme === "light")).toHaveLength(7);
    // The dark theme declares its own focus colour, so it is untouched.
    expect(failures.filter((f) => f.theme === "dark")).toEqual([]);
    // Without it in the dark overrides the light colour applies to the dark theme and is judged there.
    const light = failuresOf("--color-focus", undefined, "dark").failures;
    expect(light.length).toBeGreaterThan(0);
    expect(light.every((f) => f.theme === "dark" && f.ratio > 0)).toBe(true);
  });

  test("without the page colour nothing can be composited: one failure per theme", () => {
    const style = tokens();
    delete (style as Record<string, unknown>)["--color-bg"];
    delete style["@--dark"]["--color-bg"];
    const { checked, failures } = contrastFailures(style, highlight());
    expect(failures).toEqual([
      { theme: "light", label: "page colour: --color-bg is not defined", ratio: 0, minimum: 4.5 },
      { theme: "dark", label: "page colour: --color-bg is not defined", ratio: 0, minimum: 4.5 },
    ]);
    expect(checked).toBe(2);
  });

  test("a reference loop, and a var() with a fallback, are unreadable and not an infinite loop", () => {
    const loop = tokens();
    loop["--color-link"] = "var(--color-link-hover)";
    loop["--color-link-hover"] = "var(--color-link)";
    expect(
      contrastFailures(loop, null).failures.some(
        (f) => f.ratio === 0 && f.label.includes("var(--color-link"),
      ),
    ).toBe(true);
    const fallback = tokens();
    fallback["--color-link"] = "var(--nope, #6237BF)";
    expect(contrastFailures(fallback, null).failures.some((f) => f.ratio === 0)).toBe(true);
  });

  test("a style with no tokens fails, and a value that is not a string is not a token", () => {
    expect(contrastFailures({}, null).failures.map((f) => f.theme)).toEqual(["light", "dark"]);
    const style = tokens();
    (style as Record<string, unknown>)["--color-action"] = 5;
    expect(
      contrastFailures(style, null).failures.some((f) =>
        f.label.includes("--color-action is not defined"),
      ),
    ).toBe(true);
    expect(contrastFailures({ ...tokens(), "@--dark": null }, null).checked).toBe(80 + 64);
  });
});

describe("colours", () => {
  test("the contrast maths: black on white is 21:1, a colour on itself 1:1", () => {
    expect(Math.round(ratio("#000000", "#FFFFFF", "#FFFFFF"))).toBe(21);
    expect(ratio("#6237BF", "#6237BF", "#FFFFFF")).toBeCloseTo(1, 5);
    expect(ratio("rgba(0, 0, 0, 0.5)", "#FFFFFF", "#FFFFFF")).toBeGreaterThan(3);
    expect(ratio("#FFFFFF", "#C9B8FF", "#FFFFFF")).toBeCloseTo(1.78, 2);
  });

  test("hex in three, four, six and eight digits", () => {
    expect(parseColor("#fff")).toEqual([255, 255, 255, 1]);
    expect(parseColor("#6237BF")).toEqual([98, 55, 191, 1]);
    expect(parseColor("#0008")).toEqual([0, 0, 0, 136 / 255]);
    expect(parseColor("#62 37BF".replace(" ", ""))).toEqual([98, 55, 191, 1]);
    expect(parseColor("#11223344")).toEqual([17, 34, 51, 68 / 255]);
  });

  test("rgb() and hsl(), with commas or spaces, slash alpha and percentages", () => {
    expect(parseColor("rgb(98, 55, 191)")).toEqual([98, 55, 191, 1]);
    expect(parseColor("rgb(98 55 191)")).toEqual([98, 55, 191, 1]);
    expect(parseColor("rgba(0, 0, 0, 0.5)")).toEqual([0, 0, 0, 0.5]);
    expect(parseColor("rgb(0 0 0 / 50%)")).toEqual([0, 0, 0, 0.5]);
    expect(parseColor("rgb(100% 0% 0%)")).toEqual([255, 0, 0, 1]);
    expect(parseColor("hsl(0, 100%, 50%)")).toEqual([255, 0, 0, 1]);
    expect(parseColor("hsl(120deg 100% 25%)")).toEqual([0, 128, 0, 1]);
    expect(parseColor("hsla(240, 100%, 50%, 0.25)")).toEqual([0, 0, 255, 0.25]);
  });

  test("what it cannot read is an error that names the value", () => {
    for (const value of [
      "rebeccapurple",
      "color-mix(in srgb, red, blue)",
      "oklch(0.5 0.2 270)",
      "#12",
      "#12345",
      "rgb(1 2)",
      "rgb(a b c)",
      "",
      "var(--x)",
    ]) {
      expect(() => parseColor(value), value).toThrow(/is not a colour the check can read/);
    }
  });
});

describe("contrastOfRoot", () => {
  test("a root without docs-search.json has no highlight to check", () => {
    const root = writeTree(tempDir(), { "project.json": JSON.stringify({ style: tokens() }) });
    expect(contrastOfRoot(root)).toEqual(contrastFailures(tokens(), null));
  });

  test("a docs-search.json without a recognisable highlight rule checks nothing extra", () => {
    const root = writeTree(tempDir(), {
      "project.json": JSON.stringify({ style: tokens() }),
      "components/docs-search.json": JSON.stringify({
        tagName: "docs-search",
        style: { "& .hl": { backgroundColor: "#ffee00" } },
      }),
    });
    expect(contrastOfRoot(root).checked).toBe(144);
  });

  test("a project.json that is missing, not JSON, not an object or without style is an error that names the file", () => {
    expect(() => contrastOfRoot(tempDir())).toThrow(/project\.json/);
    expect(() => contrastOfRoot(writeTree(tempDir(), { "project.json": "{" }))).toThrow(
      /project\.json cannot be read as JSON/,
    );
    expect(() => contrastOfRoot(writeTree(tempDir(), { "project.json": "[]" }))).toThrow(
      /project\.json is not a JSON object/,
    );
    expect(() => contrastOfRoot(writeTree(tempDir(), { "project.json": "{}" }))).toThrow(
      /has no "style" object/,
    );
  });

  test("a theme applied the way generateProject writes it is what is judged", () => {
    const style = tokens();
    style["--color-action"] = "#C9B8FF"; // theme.light["--color-action"], merged into style by the project generator
    const root = writeTree(tempDir(), {
      "project.json": JSON.stringify({ style }),
      "components/docs-search.json": readFileSync(
        join(FIXTURE_ROOT, "components", "docs-search.json"),
        "utf8",
      ),
    });
    expect(contrastOfRoot(root).failures.map((f) => f.label)).toContain("primary button");
  });
});

// Integration check that runs once the site package (WP7) is merged: the tokens and the highlight the
// package really ships meet the gate, all 148 of them. Until then `site/` is absent and the test is skipped.
const shipped = join(REPO_ROOT, "site", "project.base.json");
describe.skipIf(!existsSync(shipped))("the tokens the package ships", () => {
  test("pass the gate with all 148 checks", () => {
    const style = json(shipped).style as Record<string, unknown>;
    const search = json(join(REPO_ROOT, "site", "components", "docs-search.json")).style as Record<
      string,
      unknown
    >;
    const { checked, failures } = contrastFailures(
      style,
      highlightOf(search["& .hl"] as Record<string, unknown>),
    );
    expect(failures).toEqual([]);
    expect(checked).toBe(148);
  });
});
