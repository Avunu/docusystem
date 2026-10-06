// Reading the package's site/ folder (the Jx project files WP7 owns) from the tests of test/site.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../../support/index.js";

/** The package's `site/` folder: what `assemble` copies into the generated Jx root. */
export const SITE: string = join(REPO_ROOT, "site");

/** `test/site/fixtures`: files the site tests read (not formatted, not tests). */
export const SITE_FIXTURES: string = join(REPO_ROOT, "test", "site", "fixtures");

/** The Jx packages the generated root resolves from its own `node_modules` (invariant 8). */
export const JX_PACKAGES = [
  "@jxsuite/compiler",
  "@jxsuite/parser",
  "@jxsuite/runtime",
  "@jxsuite/search",
] as const;

/** Any JSON document of the project; the tests walk them without a schema. */
export type Json = Record<string, any>;

const split = (rel: string): string[] => rel.split("/");

/** The text of a file of `site/`, by `/`-separated path. */
export const readText = (rel: string): string => readFileSync(join(SITE, ...split(rel)), "utf8");

/** A JSON document of `site/`. */
export const readJson = (rel: string): Json => JSON.parse(readText(rel)) as Json;

/** Whether `site/` holds this path. */
export const exists = (rel: string): boolean => existsSync(join(SITE, ...split(rel)));

/** The `.json` files directly in a folder of `site/`, as `folder/name.json`, sorted. */
export function jsonFiles(folder: string): string[] {
  return readdirSync(join(SITE, folder))
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => `${folder}/${name}`);
}

/**
 * Every file under `site/` (dot files included), `/`-separated and sorted, except what other work
 * packages own (`data/`, the bundled catalog of WP1).
 */
export function siteFiles(): string[] {
  const out: string[] = [];
  const visit = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const rel = `${prefix}${name}`;
      if (statSync(path).isDirectory()) {
        if (rel !== "data") visit(path, `${rel}/`);
      } else out.push(rel);
    }
  };
  visit(SITE, "");
  return out.sort();
}

export const COMPONENTS: string[] = jsonFiles("components");
export const LAYOUTS: string[] = jsonFiles("layouts");
export const PAGES: string[] = jsonFiles("pages");

/** The generated project, as the tests of the base project see it. */
export const PROJECT: Json = readJson("project.base.json");

/**
 * Every node of a document (objects and arrays, depth first, the document itself first) that
 * satisfies `match`.
 */
export function nodes(value: unknown, match: (node: Json) => boolean, found: Json[] = []): Json[] {
  if (Array.isArray(value)) for (const item of value) nodes(item, match, found);
  else if (value !== null && typeof value === "object") {
    if (match(value as Json)) found.push(value as Json);
    for (const item of Object.values(value)) nodes(item, match, found);
  }
  return found;
}

/** Every inline JavaScript body in a document: the `Function` entries of state and handlers. */
export function bodies(
  value: unknown,
  found: Array<{ where: string; body: string }> = [],
  where = "",
): Array<{ where: string; body: string }> {
  if (Array.isArray(value)) value.forEach((item, i) => bodies(item, found, `${where}[${i}]`));
  else if (value !== null && typeof value === "object") {
    const object = value as Json;
    if (object.$prototype === "Function" && typeof object.body === "string") {
      found.push({ where, body: object.body });
    }
    for (const [key, item] of Object.entries(object)) bodies(item, found, `${where}.${key}`);
  }
  return found;
}
