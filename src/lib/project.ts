// The generated `project.json` of the Jx project root (4.2 of the architecture decision record).
//
// Jx 5.0.0 has no project-level composition (`project.json` has no `extends`), so the project is the
// package's `site/project.base.json` with a site's facts written into it. Jx also ignores keys it does
// not understand and still exits 0, so what goes in is checked here, not left for Jx to notice.
//
// Order of application, lowest to highest: the base, the identity (`name`, `url`), the link check
// (`content.docs.links`, by the strictness of the run), `theme`, `images`, and last the unsupported `jx`
// fragment. The fragment may not loosen the link check (strictness is never a file setting) and says so
// when it changes the identity.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { packageRoot } from "./package-info.js";
import type { DocsConfig } from "./types.js";

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The package's own `site/` folder: the Jx project files that every docs site is made from. */
export const packageSiteDir = (): string => join(packageRoot, "site");

/** The package's `site/project.base.json` (or the one in `siteSource`, for tests). */
export function readBaseProject(siteSource: string = packageSiteDir()): Record<string, unknown> {
  const file = join(siteSource, "project.base.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`cannot read the package's ${file}: ${(error as Error).message}`, {
      cause: error,
    });
  }
  if (!isObject(parsed)) throw new Error(`${file} is not a JSON object`);
  return parsed;
}

/**
 * The design-token names the base project knows: `light` (the `style` keys that start with `--`) and
 * `dark` (the keys of `style["@--dark"]`). An override of any other name is an error, because Jx would
 * accept it and nothing would use it.
 */
export function knownTokens(base: Record<string, unknown>): {
  light: Set<string>;
  dark: Set<string>;
} {
  const style = isObject(base.style) ? base.style : {};
  const dark = isObject(style["@--dark"]) ? style["@--dark"] : {};
  return {
    light: new Set(Object.keys(style).filter((key) => key.startsWith("--"))),
    dark: new Set(Object.keys(dark)),
  };
}

/** A key that, assigned to an object, would change the object's prototype instead of adding a key. */
const UNSAFE_KEY = "__proto__";

/**
 * The `jx` escape hatch (4.2): `fragment` is merged into `project`, which is not modified. Objects merge
 * key by key; `null` deletes a key; the array at the top-level `$head` is appended to the project's
 * (the project's entries first); every other array replaces the project's and adds a warning
 * `overrides: jx.<path> replaces N entries of the package's list`.
 */
export function mergeJx(
  project: Record<string, unknown>,
  fragment: Record<string, unknown>,
  warnings: string[],
): Record<string, unknown> {
  const merge = (target: Json, patch: Json, path: string): Json => {
    const out: Json = { ...target };
    for (const key of Object.keys(patch)) {
      const where = path === "" ? key : `${path}.${key}`;
      if (key === UNSAFE_KEY) {
        warnings.push(`overrides: jx.${where} is ignored: "${key}" is not a setting`);
        continue;
      }
      const value = patch[key];
      const current = Object.hasOwn(out, key) ? out[key] : undefined;
      if (value === null) {
        delete out[key];
      } else if (isObject(value) && isObject(current)) {
        out[key] = merge(current, value, where);
      } else if (path === "" && key === "$head" && Array.isArray(value) && Array.isArray(current)) {
        out[key] = [...current, ...structuredClone(value)];
      } else {
        if (Array.isArray(current)) {
          warnings.push(
            `overrides: jx.${where} replaces ${current.length} entries of the package's list`,
          );
        }
        out[key] = structuredClone(value);
      }
    }
    return out;
  };
  return merge(project, fragment, "");
}

/** Why a theme value may not go into a stylesheet, or null when it may. */
function badTokenValue(value: unknown): string | null {
  if (typeof value !== "string") return "it is not a string";
  if (value.length > 200) return "it is longer than 200 characters";
  if (/[;{}<>\\]/.test(value)) return "it contains one of ; { } < > \\";
  if (/url\s*\(|@import/i.test(value)) return "it uses url( or @import";
  return null;
}

/** Sets `content.docs.links` when the project has a `docs` content type; true when it had to change. */
function setLinks(project: Json, mode: "error" | "warn"): boolean {
  const content = project.content;
  const docs = isObject(content) ? content.docs : undefined;
  if (!isObject(docs) || docs.links === mode) return false;
  docs.links = mode;
  return true;
}

const docsSource = (project: Json): unknown => {
  const content = project.content;
  const docs = isObject(content) ? content.docs : undefined;
  return isObject(docs) ? docs.source : undefined;
};

/**
 * The generated `project.json`: the base (without `$schema` and `$comment`, which describe the file in
 * the package) + `name` + `url` + `content.docs.links` by strictness (`"error"` makes Jx itself fail on
 * every broken link, even when docusystem runs with `--lenient`, which is why it follows the strictness)
 * + `theme` + `images` + the `jx` fragment. `errors` are problems the site cannot be built with (an
 * unknown token, an unusable value); `warnings` are fragment merges worth knowing about, each a full
 * `overrides:` line.
 */
export function generateProject(
  config: DocsConfig,
  o: { strict: boolean; base?: Record<string, unknown> },
): { project: Record<string, unknown>; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const base = o.base ?? readBaseProject();
  let project: Json = structuredClone(base);
  delete project.$schema;
  delete project.$comment;

  project.name = config.name;
  project.url = `https://${config.domain}`;
  const links = o.strict ? "error" : "warn";
  setLinks(project, links);
  const source = docsSource(project);

  const known = knownTokens(base);
  const style = isObject(project.style) ? project.style : null;
  const darkStyle = style !== null && isObject(style["@--dark"]) ? style["@--dark"] : null;
  for (const theme of ["light", "dark"] as const) {
    const target = theme === "light" ? style : darkStyle;
    const what =
      theme === "light"
        ? "a design token of this version"
        : "a design token that this version re-declares for dark mode";
    for (const [token, value] of Object.entries(config.theme?.[theme] ?? {})) {
      const bad = target !== null && known[theme].has(token) ? badTokenValue(value) : null;
      if (target === null || !known[theme].has(token)) {
        errors.push(`theme.${theme}: "${token}" is not ${what}`);
      } else if (bad !== null) {
        errors.push(`theme.${theme}: the value of "${token}" cannot be used: ${bad}`);
      } else {
        target[token] = value;
      }
    }
  }

  if (config.images === "off") project.images = { optimize: false };

  if (config.jx !== undefined) {
    project = mergeJx(project, config.jx, warnings);
    if (project.name !== config.name) {
      warnings.push(
        "overrides: jx.name replaces the project name: the name of the site comes from docusystem.config.json",
      );
    }
    if (project.url !== `https://${config.domain}`) {
      warnings.push(
        "overrides: jx.url replaces the project URL: the address of the site comes from `domain` in docusystem.config.json",
      );
    }
    if (docsSource(project) !== source) {
      warnings.push(
        "overrides: jx.content.docs.source replaces the folder the Markdown is read from: the site will not show the staged documents",
      );
    }
    if (setLinks(project, links)) {
      warnings.push(
        "overrides: jx.content.docs.links is ignored: the link check follows the strictness of the run (--strict, --lenient, CI)",
      );
    }
  }
  return { project, errors, warnings };
}
