// Steps 1 and 2 of the pipeline (5.1), before anything is assembled or built: the configuration is
// valid, the Markdown folder is inside the repository and has a home page, the slug is the catalog's
// spelling, and the site folder holds no leftovers of the copied starter. Everything that is wrong is
// reported at once; the build never guesses a value that is missing (1.4).
import { type Dirent, existsSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { readBundledCatalog } from "./catalog.js";
import { ConfigError, pathsFor, readConfig } from "./config.js";
import { sha256 } from "./fsutil.js";
import { packageRoot } from "./package-info.js";
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

/** The earlier starter's configuration file, which `docusystem.config.json` replaced. */
export const LEGACY_CONFIG_FILE = "docs.config.json";

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
  {
    name: "data",
    advice:
      "The project catalog is bundled in the package (a release refreshes it): delete this folder",
  },
  {
    name: LEGACY_CONFIG_FILE,
    advice:
      "The configuration is docusystem.config.json now, and `docusystem init` carries the values over: delete this file once docusystem.config.json has them",
  },
  {
    name: "README.md",
    advice:
      "It describes scripts that no longer exist, and the package's own documentation replaces it: delete this file",
  },
];

/** A leftover of the copied starter in the site folder (2.4 of the decision record). */
export interface Leftover {
  /** The entry of the site folder, without a trailing slash: `components`, `project.json`, `public`. */
  name: string;
  /** What to do about it. */
  advice: string;
  /** The warning `check` prints; it starts with the entry as an author writes it (`components/`). */
  message: string;
}

/** An entry of the site folder as an author writes it: a folder with a trailing slash. */
export const entryName = (name: string): string => (name.includes(".") ? name : `${name}/`);

/**
 * The files below `<site>/public` that are byte for byte the package's own file of the same path:
 * what the starter's `public/` (its fonts, brand marks, favicon and `.nojekyll`) is when it was copied
 * into a shell. A real `public/` holds files the package does not have, or files that differ. Symbolic
 * links are not followed and nothing unreadable is an error: this only informs a warning.
 */
function copiesOfPackagePublic(sitePublic: string, packagePublic: string): string[] {
  const copies: string[] = [];
  const visit = (dir: string, prefix: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = `${prefix}${entry.name}`;
      if (entry.isDirectory()) visit(join(dir, entry.name), `${rel}/`);
      else if (entry.isFile()) {
        const ours = join(packagePublic, ...rel.split("/"));
        try {
          if (existsSync(ours) && sha256(join(dir, entry.name)) === sha256(ours)) copies.push(rel);
        } catch {
          // unreadable: not a copy we can prove
        }
      }
    }
  };
  visit(sitePublic, "");
  return copies.sort();
}

/**
 * What the copied starter left in the site folder (2.4 of the decision record), in a fixed order:
 * `components/`, `layouts/`, `pages/`, `project.json`, `scripts/`, `data/`, `docs.config.json`,
 * `README.md`, then `public/` when it holds copies of the package's own files (a `public/` that is a
 * shell's own is not a leftover, rung 2 of the ladder). Reads only names, and the bytes of `public/`
 * files that the package also has. `siteSource` is the package's `site/` folder, for tests.
 */
export function starterLeftovers(siteDir: string, o: { siteSource?: string } = {}): Leftover[] {
  const found: Leftover[] = LEFTOVERS.filter(({ name }) => existsSync(join(siteDir, name))).map(
    ({ name, advice }) => ({
      name,
      advice,
      message: `${entryName(name)} in the site folder is ignored: it looks like a leftover of the copied starter. ${advice}.`,
    }),
  );
  const copies = copiesOfPackagePublic(
    join(siteDir, "public"),
    join(o.siteSource ?? join(packageRoot, "site"), "public"),
  );
  if (copies.length > 0) {
    const cname = existsSync(join(siteDir, "public", "CNAME"));
    const advice =
      "Delete the folder, or keep only the files you added or changed on purpose" +
      (cname ? "; public/CNAME is not allowed either, it is generated from `domain`" : "");
    found.push({
      name: "public",
      advice,
      message:
        `public/ in the site folder holds ${copies.length} file${copies.length === 1 ? "" : "s"} identical to the package's own ` +
        `(${copies.slice(0, 3).join(", ")}${copies.length > 3 ? ", ..." : ""}): it looks like a leftover of the copied starter. ` +
        `They replace the package's files on every build and do not follow package updates. ${advice}.`,
    });
  }
  return found;
}

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
export function preflight(
  siteDir: string,
  o: { siteSource?: string } = {},
): {
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

  for (const leftover of starterLeftovers(paths.siteDir, o)) warnings.push(leftover.message);

  return { config, paths, errors, warnings };
}
