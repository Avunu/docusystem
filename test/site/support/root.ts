// A small stand-in for `assemble` (WP2) so that the site assets can be built by the real, pinned Jx
// before WP2 exists: it copies the package's site/ into a folder, writes what WP2, WP3 and WP1 will
// write (project.json, the resolved config, CNAME, the catalog, the staged Markdown and the nav
// data from fixtures) and links the four Jx packages. Once WP2 is merged, test/assemble builds the
// same root with the real `assemble` and the integration checks listed in the pull request run.
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { REPO_ROOT } from "../../support/index.js";
import type { Catalog, NavData } from "../../../src/lib/types.js";
import { SAMPLE_CATALOG } from "./catalog.js";
import { DOCS_FIXTURE, FIXTURE_CONFIG, NAV_FIXTURE } from "./fixtures.js";
import { JX_PACKAGES, SITE, type Json } from "./site.js";

export interface RootOptions {
  /** Replaces keys of the resolved config (`docusystem.config.json` of the root). */
  config?: Partial<Record<keyof typeof FIXTURE_CONFIG, string>>;
  /** `content.docs.links`: "error" when strict (the default, as in CI), "warn" otherwise. */
  strict?: boolean;
  /** The catalog snapshot; `null` writes none. */
  catalog?: Catalog | null;
  /** The sidebar data; by default the one recorded for the documentation fixture. */
  nav?: NavData;
  /** A folder to stage as the documentation; by default the documentation fixture. */
  docs?: string;
  /** More staged Markdown, by path below the documentation folder. */
  extraDocs?: Record<string, string>;
  /** Replaces the base project before it is written (after `$schema` and `$comment` are dropped). */
  project?: (project: Json) => void;
}

/** The directory of an installed Jx package, from this repository's own `node_modules`. */
export function jxPackage(name: string): string {
  const dir = realpathSync(join(REPO_ROOT, "node_modules", ...name.split("/")));
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name: string };
  if (manifest.name !== name) throw new Error(`${dir} is ${manifest.name}, not ${name}`);
  return dir;
}

/** The compiler's CLI script, run with `process.execPath` as the package does. */
export const jxCli = (): string => join(jxPackage("@jxsuite/compiler"), "bin", "jx.js");

/** The versions of the Jx packages this repository has installed. */
export function jxVersions(): Record<string, string> {
  return Object.fromEntries(
    JX_PACKAGES.map((name) => [
      name,
      (JSON.parse(readFileSync(join(jxPackage(name), "package.json"), "utf8")) as Json).version,
    ]),
  );
}

const writeText = (file: string, text: string): void => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const writeJson = (file: string, value: unknown): void =>
  writeText(file, `${JSON.stringify(value, null, 2)}\n`);

/**
 * Builds a Jx project root in `root` (an existing or new folder) the way section 3.2 lays it out, and
 * returns it. `project.json` is the base without `$schema` and `$comment`, plus name, url and links.
 */
export function assembleRoot(root: string, o: RootOptions = {}): string {
  const config = { ...FIXTURE_CONFIG, ...o.config };
  mkdirSync(root, { recursive: true });

  // 1. the package's site/ (everything but the base project and the bundled catalog)
  for (const folder of ["components", "layouts", "pages", "public"]) {
    cpSync(join(SITE, folder), join(root, folder), { recursive: true, dereference: false });
  }

  // 2. generated files
  const base = JSON.parse(readFileSync(join(SITE, "project.base.json"), "utf8")) as Json;
  delete base.$schema;
  delete base.$comment;
  base.name = config.name;
  base.url = `https://${config.domain}`;
  base.content.docs.links = o.strict === false ? "warn" : "error";
  o.project?.(base);
  writeJson(join(root, "project.json"), base);
  writeJson(join(root, "docusystem.config.json"), config);
  writeText(join(root, "public", "CNAME"), `${config.domain}\n`);
  if (o.catalog !== null) {
    writeJson(join(root, "data", "projects.snapshot.json"), o.catalog ?? SAMPLE_CATALOG);
  }

  // 3. the staged Markdown and its navigation
  cpSync(o.docs ?? DOCS_FIXTURE, join(root, ".generated", "docs"), { recursive: true });
  for (const [path, text] of Object.entries(o.extraDocs ?? {})) {
    writeText(join(root, ".generated", "docs", ...path.split("/")), text);
  }
  const nav = o.nav ?? (JSON.parse(readFileSync(NAV_FIXTURE, "utf8")) as NavData);
  writeJson(join(root, ".generated", "nav.json"), nav);

  // 4. the Jx packages, as junction links (a junction needs no privilege on Windows)
  for (const name of JX_PACKAGES) {
    const link = join(root, "node_modules", ...name.split("/"));
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(jxPackage(name), link, "junction");
  }
  return root;
}

export interface JxRun {
  status: number | null;
  /** Standard output and standard error, in that order. */
  output: string;
  /** The `N` of `Done: N routes`, or null. */
  routes: number | null;
}

/** Runs the pinned Jx on a root: `process.execPath <compiler>/bin/jx.js build <root>`, cwd the root. */
export function runJx(root: string): JxRun {
  const result = spawnSync(process.execPath, [jxCli(), "build", root], {
    cwd: root,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: root, CI: "true", NO_COLOR: "1" },
    timeout: 50_000,
  });
  const output = `${result.stdout}${result.stderr}`;
  const done = /^Done:\s+(\d+)\s+routes?/m.exec(output);
  return { status: result.status, output, routes: done ? Number(done[1]) : null };
}

/** The output of a Jx run, `<root>/dist`. */
export const distOf = (root: string): string => join(root, "dist");

/** Every file under a folder, `/`-separated and sorted (dot files included). */
export function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const visit = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) visit(join(current, entry.name), `${prefix}${entry.name}/`);
      else out.push(`${prefix}${entry.name}`);
    }
  };
  if (existsSync(dir)) visit(dir, "");
  return out.sort();
}

/** The text of a file of a built site. */
export const readDist = (root: string, rel: string): string =>
  readFileSync(join(distOf(root), ...rel.split("/")), "utf8");
