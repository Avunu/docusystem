// Links from a documentation page to a file or folder of the repository that is not a page: source
// files, LICENSE, a folder of examples. A README copied into docs/ is full of them, written
// relative to the repository root. They cannot be pages, so the build turns each one that exists in
// the repository into a link to it on GitHub (`/blob/` for a file, `/tree/` for a folder, and the raw
// file for an image).
//
// This module serves two steps of the pipeline. Staging (stage.ts, step 5) rewrites the Markdown
// before Jx runs and uses `githubUrl`. Post-build (WP4, step 11) repairs what is left in the built
// HTML, the raw `<a href>` and `<img src>` that Markdown rewriting cannot reach, with
// `rewriteRepoLinks`; it is called there with the options below, and it needs nothing from the
// other modules of the post-build.
import { existsSync, statSync } from "node:fs";
import { join, posix, relative, resolve, sep } from "node:path";
import { isInside } from "./fsutil.js";
import type { RepoLink } from "./types.js";

export type { RepoLink };

export interface RepoLinkOptions {
  /** The site's dist/ folder: a link that already resolves there is left alone. */
  dist: string;
  /** The repository root. */
  repoRoot: string;
  /** The folder the Markdown lives in (the repository's docs/). */
  docsDir: string;
  /** https://github.com/<owner>/<name> */
  repoUrl: string;
  branch: string;
}

const entities = (value: string) =>
  value.replaceAll("&amp;", "&").replaceAll("&quot;", '"').replaceAll("&#39;", "'");
const encodeAttr = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");

/** Whether `path` is served by a static host from `dist`: a file, or a folder with an index.html. */
function servedFromDist(dist: string, path: string): boolean {
  const clean = path.replace(/^\//, "");
  if (path.endsWith("/")) return existsSync(join(dist, clean, "index.html"));
  const direct = join(dist, clean);
  if (existsSync(direct) && statSync(direct).isFile()) return true;
  return existsSync(join(dist, clean, "index.html"));
}

/**
 * The repository path (relative to the repo root, `/`-separated) a link points at, or null. The
 * link is read next to the document first (`sourceDir` is the document's folder inside docs/, "" at
 * the top), then from the repository root, as a README written for the root would have it. A link
 * that leaves the repository, an address, an anchor and a site-absolute path are never repository
 * links.
 */
export function repoTarget(
  href: string,
  sourceDir: string,
  options: Pick<RepoLinkOptions, "repoRoot" | "docsDir">,
): string | null {
  const bare = (href.split("#")[0] ?? "").split("?")[0] ?? "";
  if (
    bare === "" ||
    bare.startsWith("/") ||
    /^[a-z][a-z0-9+.-]*:/i.test(bare) ||
    bare.startsWith("//")
  )
    return null;
  let decoded = bare;
  try {
    decoded = decodeURIComponent(bare);
  } catch {
    // keep the raw text
  }
  for (const base of [join(options.docsDir, ...sourceDir.split("/")), options.repoRoot]) {
    const candidate = resolve(base, decoded);
    if (isInside(options.repoRoot, candidate) && existsSync(candidate)) {
      return relative(options.repoRoot, candidate).split(sep).join("/");
    }
  }
  return null;
}

/**
 * The GitHub address of a repository path: `blob` for a file, `tree` for a folder, and `raw` for a
 * file that is an image (`asset`). The path must exist in `repoRoot` (a folder is found by looking).
 */
export function githubUrl(
  options: Pick<RepoLinkOptions, "repoUrl" | "branch" | "repoRoot">,
  repoPath: string,
  asset: boolean,
): string {
  const full = join(options.repoRoot, ...repoPath.split("/"));
  const isDir = statSync(full).isDirectory();
  const kind = asset && !isDir ? "raw" : isDir ? "tree" : "blob";
  const path =
    repoPath === ""
      ? ""
      : `/${posix.normalize(repoPath).split("/").map(encodeURIComponent).join("/")}`;
  return `${options.repoUrl}/${kind}/${options.branch}${path}`;
}

/**
 * Rewrites the broken repository-relative links of one built page. `route` is the page's address
 * and `sourceDir` the folder of its Markdown file inside docs/ ("" at the top). A link that already
 * resolves in `dist` (a page, a copied image) is left alone; so is an address, an anchor, a
 * site-absolute path and a link that finds nothing in the repository. Returns the new HTML and the
 * links it changed.
 */
export function rewriteRepoLinks(
  html: string,
  route: string,
  sourceDir: string,
  options: RepoLinkOptions,
): { html: string; links: RepoLink[] } {
  const links: RepoLink[] = [];
  const out = html.replace(/<(a|img)\b([^>]*)>/gi, (tag, name: string, attrs: string) => {
    const attribute = name.toLowerCase() === "a" ? "href" : "src";
    const match = new RegExp(`\\s${attribute}=("([^"]*)"|'([^']*)')`).exec(attrs);
    if (!match) return tag;
    const value = entities(match[2] ?? match[3] ?? "");
    if (
      value === "" ||
      value.startsWith("#") ||
      /^[a-z][a-z0-9+.-]*:/i.test(value) ||
      value.startsWith("//") ||
      value.startsWith("/")
    )
      return tag;
    // Resolves in the built site (a page, a copied image, an anchor): leave it alone.
    const bare = (value.split("#")[0] ?? "").split("?")[0] ?? "";
    const served = posix.join(route.endsWith("/") ? route : `${posix.dirname(route)}/`, bare);
    if (
      bare !== "" &&
      servedFromDist(
        options.dist,
        served + (bare.endsWith("/") && !served.endsWith("/") ? "/" : ""),
      )
    )
      return tag;
    const target = repoTarget(value, sourceDir, options);
    if (target === null) return tag;
    const hash = value.includes("#") ? `#${value.split("#").slice(1).join("#")}` : "";
    const url = githubUrl(options, target, attribute === "src") + hash;
    links.push({ page: route, from: value, to: url });
    // A function, not a string: `$&` and `$1` in the address (a fragment may hold them) are not patterns.
    return tag.replace(match[0], () => ` ${attribute}="${encodeAttr(url)}"`);
  });
  return { html: out, links };
}
