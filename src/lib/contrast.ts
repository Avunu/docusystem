// Step 15 of the pipeline (section 5.1): the WCAG contrast gate of `docusystem check`, over the design
// tokens of the assembled project (the package's tokens with the project's `theme` overrides applied),
// so that a theme cannot quietly make the site inaccessible.
//
// It resolves every colour token for the light theme and for the dark theme (the `@--dark` overrides
// on top of the light tokens), then tests the foreground and background pairs the components use:
// 4.5:1 for text, 3:1 for large text, focus rings and UI boundaries. A pair below its minimum fails
// `check`.
//
// The pairs are a list (PAIRS) plus the search highlight, which is read from the component's own
// style (a colour mixed into transparent, so its contrast depends on the row behind it). A colour pair
// that is in no list is not checked: the browser suites of the package repository (axe on every page,
// with the palette, the menus and the drawer open) are what catches those.
//
// The gate is total over what a project can write: a token that is missing or whose value the check
// cannot read (a colour name, `color-mix(...)`) is a failure that says so, never an exception, because
// a pair that cannot be measured has not been shown to pass.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Failure, Highlight } from "./types.js";

type Tokens = Record<string, string>;
export type Pair = [foreground: string, background: string, minimum: number, label: string];

const collect = (src: Record<string, unknown>): Tokens =>
  Object.fromEntries(
    Object.entries(src).filter(([k, v]) => k.startsWith("--") && typeof v === "string"),
  ) as Tokens;

/** The colour tokens of each theme: the light ones, and the dark ones laid over a copy of them. */
export function themes(style: Record<string, unknown>): { light: Tokens; dark: Tokens } {
  const light = collect(style);
  const overrides = style["@--dark"];
  return {
    light,
    dark: {
      ...light,
      ...collect(
        overrides !== null && typeof overrides === "object"
          ? (overrides as Record<string, unknown>)
          : {},
      ),
    },
  };
}

/** A token or colour the gate cannot read; caught per pair and reported as a failure. */
class Unreadable extends Error {}

function resolveToken(name: string, tokens: Tokens, depth = 0): string {
  const raw = tokens[name];
  if (raw === undefined) throw new Unreadable(`${name} is not defined`);
  const ref = /^var\((--[\w-]+)\)$/.exec(raw.trim());
  if (ref && depth < 8) return resolveToken(ref[1]!, tokens, depth + 1);
  return raw.trim();
}

type Rgba = [number, number, number, number];

const clamp = (value: number, low: number, high: number): number =>
  Math.min(high, Math.max(low, value));

/** A CSS number or percentage as a number, a percentage being `percent` per 100%; null when it is neither. */
function component(text: string | undefined, percent: number): number | null {
  if (text === undefined) return null;
  const match = /^([+-]?(?:\d+\.?\d*|\.\d+))(%?)$/.exec(text);
  if (!match) return null;
  const value = Number(match[1]);
  return match[2] === "%" ? (value / 100) * percent : value;
}

function hslToRgb(hue: number, saturation: number, lightness: number): [number, number, number] {
  const s = clamp(saturation, 0, 100) / 100;
  const l = clamp(lightness, 0, 100) / 100;
  const k = (n: number): number => (n + hue / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const channel = (n: number): number =>
    Math.round((l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))) * 255);
  return [channel(0), channel(8), channel(4)];
}

/**
 * A colour as red, green, blue (0 to 255) and alpha (0 to 1). Reads `#rgb`, `#rgba`, `#rrggbb`,
 * `#rrggbbaa`, `rgb()`/`rgba()` and `hsl()`/`hsla()` (comma or space separated, `/ alpha`, percentages).
 * Throws on anything else: colour names, `color-mix()`, `oklch()` and the rest are not measured.
 */
export function parseColor(color: string): Rgba {
  const text = color.trim();
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(text);
  if (hex) {
    const digits = hex[1]!.length <= 4 ? [...hex[1]!].map((c) => c + c).join("") : hex[1]!;
    const byte = (at: number): number => Number.parseInt(digits.slice(at, at + 2), 16);
    return [byte(0), byte(2), byte(4), digits.length === 8 ? byte(6) / 255 : 1];
  }
  const fn = /^(rgba?|hsla?)\(\s*([^()]*?)\s*\)$/i.exec(text);
  if (fn) {
    const parts = fn[2]!.split(/\s*[,/]\s*|\s+/).filter((part) => part !== "");
    const alpha = parts.length === 4 ? component(parts[3], 1) : parts.length === 3 ? 1 : null;
    if (alpha !== null) {
      const opacity = clamp(alpha, 0, 1);
      if (fn[1]!.toLowerCase().startsWith("rgb")) {
        const channels = [0, 1, 2].map((i) => component(parts[i], 255));
        if (channels.every((c): c is number => c !== null)) {
          return [
            clamp(channels[0]!, 0, 255),
            clamp(channels[1]!, 0, 255),
            clamp(channels[2]!, 0, 255),
            opacity,
          ];
        }
      } else {
        const h = component(parts[0]?.replace(/deg$/i, ""), 360);
        const s = component(parts[1], 100);
        const l = component(parts[2], 100);
        if (h !== null && s !== null && l !== null) {
          const [r, g, b] = hslToRgb(((h % 360) + 360) % 360, s, l);
          return [r, g, b, opacity];
        }
      }
    }
  }
  throw new Unreadable(
    `"${color}" is not a colour the check can read (write it as #rrggbb, rgb() or hsl())`,
  );
}

const over = (fg: Rgba, bg: Rgba): [number, number, number] =>
  [0, 1, 2].map((i) => fg[i]! * fg[3] + bg[i]! * (1 - fg[3])) as [number, number, number];

function luminance([r, g, b]: [number, number, number]): number {
  const f = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** The contrast ratio of a foreground over a background, both over the page colour. */
export function ratio(fg: string, bg: string, page: string): number {
  const base = parseColor(page);
  const back = over(parseColor(bg), [base[0], base[1], base[2], 1]);
  const front = over(parseColor(fg), [...back, 1]);
  const [hi, lo] = [luminance(front), luminance(back)].sort((a, b) => b - a) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const T = 4.5;
const L = 3;

/** The foreground and background pairs the components use, with the minimum ratio of each. */
export const PAIRS: Pair[] = (() => {
  const pairs: Pair[] = [];
  for (const bg of [
    "--color-bg",
    "--color-bg-sand",
    "--color-bg-lavender",
    "--color-surface",
    "--color-surface-raised",
    "--color-surface-muted",
    "--color-surface-subtle",
  ]) {
    pairs.push(["--color-text", bg, T, `text on ${bg}`]);
    pairs.push(["--color-text-muted", bg, T, `muted text on ${bg}`]);
    pairs.push(["--color-text-caption", bg, T, `caption on ${bg}`]);
    pairs.push(["--color-link", bg, T, `link on ${bg}`]);
    pairs.push(["--color-link-hover", bg, T, `link hover on ${bg}`]);
    pairs.push(["--color-focus", bg, L, `focus ring on ${bg}`]);
  }
  pairs.push(
    ["--color-text-placeholder", "--color-surface", T, "search placeholder"],
    ["--color-on-action", "--color-action", T, "primary button"],
    ["--color-on-action", "--color-action-hover", T, "primary button hover"],
    ["--color-on-action-soft", "--color-action-soft", T, "secondary button"],
    ["--color-on-tint", "--color-tint", T, "current sidebar item, tags, switcher current project"],
    ["--color-text", "--color-code-bg", T, "inline code"],
    ["--color-rule-strong", "--color-bg", L, "table header rule"],
  );
  for (const kind of ["note", "tip", "important", "warning", "caution"]) {
    pairs.push([`--callout-${kind}-fg`, `--callout-${kind}-bg`, T, `${kind} callout title`]);
    pairs.push(["--color-text", `--callout-${kind}-bg`, T, `${kind} callout body`]);
    pairs.push(["--color-link", `--callout-${kind}-bg`, T, `link inside a ${kind} callout`]);
  }
  for (const bg of [
    "--color-night",
    "--color-night-surface",
    "--color-night-surface-2",
    "--color-night-surface-3",
  ]) {
    pairs.push(["--color-night-text", bg, T, `night text on ${bg}`]);
    pairs.push(["--color-night-muted", bg, T, `night muted on ${bg}`]);
    pairs.push(["--color-night-link", bg, T, `night link on ${bg}`]);
    pairs.push(["--color-night-focus", bg, L, `night focus ring on ${bg}`]);
  }
  return pairs;
})();

/** Reads the highlight out of a component style such as docs-search's `& .hl` rule. */
export function highlightOf(rule: Record<string, unknown> | undefined): Highlight | null {
  const value = typeof rule?.backgroundColor === "string" ? rule.backgroundColor : "";
  const m = /^color-mix\(in srgb,\s*var\((--[\w-]+)\)\s+(\d+(?:\.\d+)?)%,\s*transparent\)$/.exec(
    value.trim(),
  );
  if (!m) return null;
  const own = /^var\((--[\w-]+)\)$/.exec(String(rule?.color ?? "").trim());
  return {
    token: m[1]!,
    percent: Number(m[2]),
    text: own ? [own[1]!] : ["--color-text", "--color-text-caption"],
  };
}

/** `foreground` laid over `background` at `alpha`, as a hex colour. */
function blend(foreground: string, alpha: number, background: string): string {
  const [front, back] = [parseColor(foreground), parseColor(background)];
  const mixed = [0, 1, 2].map((i) =>
    Math.round(front[i]! * alpha + back[i]! * (1 - alpha))
      .toString(16)
      .padStart(2, "0"),
  );
  return `#${mixed.join("")}`;
}

const rounded = (value: number): number => Math.round(value * 100) / 100;

/**
 * Step 15: every pair of PAIRS in both themes (the night tokens, which are the same in both, once),
 * and the search highlight over the surface of the palette and over the surface of a hovered row.
 * `style` is the `style` object of the assembled project.json. `checked` counts what was measured or
 * could not be. A failure with a ratio of 0 is a token the check could not read or find; its label
 * says which and why.
 */
export function contrastFailures(
  style: Record<string, unknown>,
  highlight: Highlight | null,
): { checked: number; failures: Failure[] } {
  const { light, dark } = themes(style);
  const failures: Failure[] = [];
  let checked = 0;
  for (const [theme, tokens] of [
    ["light", light],
    ["dark", dark],
  ] as const) {
    let page: string;
    try {
      page = resolveToken("--color-bg", tokens);
      parseColor(page);
    } catch (error) {
      if (!(error instanceof Unreadable)) throw error;
      // Without the page colour nothing can be composited: say so once and stop for this theme.
      checked++;
      failures.push({ theme, label: `page colour: ${error.message}`, ratio: 0, minimum: T });
      continue;
    }
    for (const [fg, bg, minimum, label] of PAIRS) {
      // Night tokens are the same in both themes: test them once.
      if (theme === "dark" && label.startsWith("night ")) continue;
      checked++;
      try {
        const value = ratio(resolveToken(fg, tokens), resolveToken(bg, tokens), page);
        if (value < minimum) failures.push({ theme, label, ratio: rounded(value), minimum });
      } catch (error) {
        if (!(error instanceof Unreadable)) throw error;
        failures.push({ theme, label: `${label}: ${error.message}`, ratio: 0, minimum });
      }
    }
    if (highlight) {
      // The mark sits on the palette's surface, and on the surface of a hovered or active row.
      for (const row of ["--color-surface", "--color-surface-muted"]) {
        for (const text of highlight.text) {
          checked++;
          const label = `search highlight (${text}) on ${row}`;
          try {
            const background = blend(
              resolveToken(highlight.token, tokens),
              highlight.percent / 100,
              resolveToken(row, tokens),
            );
            const value = ratio(resolveToken(text, tokens), background, page);
            if (value < T) failures.push({ theme, label, ratio: rounded(value), minimum: T });
          } catch (error) {
            if (!(error instanceof Unreadable)) throw error;
            failures.push({ theme, label: `${label}: ${error.message}`, ratio: 0, minimum: T });
          }
        }
      }
    }
  }
  return { checked, failures };
}

/** One failure as a line: `light: link on --color-bg is 2.1:1, needs 4.5:1`. */
export function formatFailure(failure: Failure): string {
  return failure.ratio === 0
    ? `${failure.theme}: ${failure.label}`
    : `${failure.theme}: ${failure.label} is ${failure.ratio}:1, needs ${failure.minimum}:1`;
}

function readJson(file: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${file} cannot be read as JSON: ${(error as Error).message}`, {
      cause: error,
    });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${file} is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Step 15 on an assembled project root: the effective tokens are `<root>/project.json`'s `style`
 * (the package's tokens with the config's `theme` applied by `generateProject`) and the search
 * highlight is the `& .hl` rule of `<root>/components/docs-search.json`. Throws when project.json has
 * no `style` object. A root without docs-search.json has no highlight to check.
 */
export function contrastOfRoot(root: string): { checked: number; failures: Failure[] } {
  const project = readJson(join(root, "project.json"));
  const style = project.style;
  if (style === null || typeof style !== "object" || Array.isArray(style)) {
    throw new Error(
      `${join(root, "project.json")} has no "style" object: there are no tokens to check`,
    );
  }
  let rule: Record<string, unknown> | undefined;
  const searchFile = join(root, "components", "docs-search.json");
  if (existsSync(searchFile)) {
    const searchStyle = readJson(searchFile).style;
    if (searchStyle !== null && typeof searchStyle === "object") {
      const hl = (searchStyle as Record<string, unknown>)["& .hl"];
      if (hl !== null && typeof hl === "object") rule = hl as Record<string, unknown>;
    }
  }
  return contrastFailures(style as Record<string, unknown>, highlightOf(rule));
}
