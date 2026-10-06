// Steps 1 and 2 of the pipeline (5.1), before anything is assembled or built: the configuration is
// valid, the Markdown folder is inside the repository and has a home page, the slug is the catalog's
// spelling, and the site folder holds no leftovers of the copied starter. Everything that is wrong is
// reported at once; the build never guesses a value that is missing (1.4).
import { type Dirent, existsSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { readBundledCatalog } from "./catalog.js";
import { ConfigError, pathsFor, readConfig } from "./config.js";
import type { DocsConfig, Paths } from "./types.js";

const flat = (slug: string): string => slug.toLowerCase().replaceAll("_", "-");

/**
 * What the catalog says about a slug: an error when a different spelling of it is the catalog's key
 * (`erpnext-taskview` for `erpnext_taskview`: the project switcher would never mark the project as the
 * current one), a warning when it is not in the catalog at all, nothing when it is there. `slugs`
 * defaults to the keys of the bundled catalog; an empty catalog says nothing.
 */
export function checkSlug(
  slug: string,
  slugs: string[] = readBundledCatalog().map((project) => project.slug),
): { error?: string; warning?: string } {
  if (slugs.length === 0 || slugs.includes(slug)) return {};
  const close = slugs.find((candidate) => flat(candidate) === flat(slug));
  if (close !== undefined) {
    return {
      error: `slug "${slug}" is not in the project catalog, but "${close}" is: the project switcher would never mark this project as the current one. Set "slug" to "${close}" (the domain stays as it is).`,
    };
  }
  return {
    warning: `slug "${slug}" is not in the project catalog, so the project switcher will not mark this project as the current one. Add the project to the avunu.net catalog first.`,
  };
}

/** What the starter copied into the site folder, and what to do about each; none of it is read. */
const LEFTOVERS: Array<{ name: string; advice: string }> = [
  {
    name: "components",
    advice:
      "Overrides go in overrides/components/ (`docusystem eject` copies a package file there); delete this folder or move what you changed",
  },
  {
    name: "layouts",
    advice:
      "Overrides go in overrides/layouts/ (`docusystem eject` copies a package file there); delete this folder or move what you changed",
  },
  {
    name: "pages",
    advice:
      "Overrides go in overrides/pages/ (`docusystem eject` copies a package file there); delete this folder or move what you changed",
  },
  {
    name: "project.json",
    advice:
      'docusystem generates the Jx project from docusystem.config.json: put changes in "theme" (or, as a last resort, "jx") and delete this file',
  },
  {
    name: "scripts",
    advice: "docusystem runs the build itself: delete this folder",
  },
];

/** A path inside the repository as the author writes it: relative, `/`-separated, `.` for the root. */
const shown = (repoRoot: string, path: string): string =>
  relative(repoRoot, path).split(sep).join("/") || ".";

/** What is wrong with the Markdown folder `dir` as the documentation home, as a sentence, or null. */
function homeProblem(dir: string, docs: string): string | null {
  const readme = docs === "." ? "README.md" : `${docs}/README.md`;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return `The documentation folder ${docs}/ does not exist. Put your Markdown there; ${readme} is the home page.`;
    }
    if (code === "ENOTDIR") return `The documentation folder ${docs} is not a folder.`;
    return `The documentation folder ${docs}/ cannot be read (${(error as Error).message}).`;
  }
  // README.md, readme.md or index.md, in any case; a folder of that name is not a page.
  if (entries.some((e) => /^(?:readme|index)\.md$/i.test(e.name) && !e.isDirectory())) return null;
  return (
    `${readme} is missing: it is the documentation home (/docs/). Add one (index.md works too)` +
    (docs === "."
      ? "."
      : `; for a repository whose README is its documentation: cp README.md ${readme}`)
  );
}

/**
 * Steps 1 and 2 of the pipeline (5.1): reads and validates the configuration and resolves the paths
 * (every problem of the configuration at once), then checks the Markdown folder and its home page, the
 * slug against the bundled catalog (an error for a differently spelled key, a warning for an unknown
 * one) and the site folder for starter leftovers (warnings). `config` and `paths` are present when they
 * could be made, even if errors followed. Nothing is written.
 */
export function preflight(siteDir: string): {
  config?: DocsConfig;
  paths?: Paths;
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];

  let config: DocsConfig;
  try {
    config = readConfig(siteDir);
  } catch (error) {
    if (error instanceof ConfigError) return { errors: error.problems, warnings };
    throw error;
  }
  let paths: Paths;
  try {
    paths = pathsFor(siteDir, config);
  } catch (error) {
    if (error instanceof ConfigError) return { config, errors: error.problems, warnings };
    throw error;
  }

  // Step 2: the home page.
  const home = homeProblem(paths.docsDir, shown(paths.repoRoot, paths.docsDir));
  if (home !== null) errors.push(home);

  // The slug against the catalog that ships with this version.
  try {
    const slug = checkSlug(config.slug);
    if (slug.error !== undefined) errors.push(slug.error);
    if (slug.warning !== undefined) warnings.push(slug.warning);
  } catch (error) {
    errors.push((error as Error).message);
  }

  for (const { name, advice } of LEFTOVERS) {
    if (existsSync(join(paths.siteDir, name))) {
      warnings.push(
        `${name}${name.includes(".") ? "" : "/"} in the site folder is ignored: it looks like a leftover of the copied starter. ${advice}.`,
      );
    }
  }

  return { config, paths, errors, warnings };
}
