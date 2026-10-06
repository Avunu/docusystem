#!/usr/bin/env node
// Compares two built sites (two `dist/` folders) and reports every file that differs, ignoring only what
// the build does not control:
//
//   - the ORDER in which Jx emits component CSS (`<style>` blocks) and the component module scripts and
//     modulepreload links of a page: it follows the order of a directory listing, which differs between
//     file systems. The blocks themselves must be equal, only their order may differ.
//   - the bytes of the three vendored bundles (assets/lit-html.js, vue-reactivity.js,
//     jxsuite-search-client.js) when the two builds ran on different runtimes: Bun's bundler minifies
//     them differently from esbuild on Node. They are compared byte for byte when the runtimes are
//     the same (or not stated), because then any difference is a real one.
//
// Everything else is compared byte for byte, including whitespace. A file present on one side only is a
// difference. `--allow` names files that are expected to differ (they are listed, and do not fail the
// run), for example the one intentional fix of a release.
//
//   node scripts/compare-dist.mjs <dist-a> <dist-b> [options]
//
//   --allow <path>              A file (relative to dist, "/"-separated) that may differ. Repeatable.
//   --runtime-a <node|bun>      The runtime that built A.
//   --runtime-b <node|bun>      The runtime that built B.
//   --vendored <auto|compare|skip>
//                               auto (default): skip the vendored bundles only when both runtimes are
//                               given and differ; compare: always compare; skip: never compare.
//   --json                      Print the result as JSON (the human summary goes to stderr).
//
// Exit codes: 0 the trees are equal apart from what is allowed or ignored; 1 they differ; 2 usage error.
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

/** The three bundles Jx vendors into every site; their bytes depend on the bundler. */
export const VENDORED = /^assets\/(?:lit-html|vue-reactivity|jxsuite-search-client)\.js$/;

const STYLE = /(<style\b[^>]*>)([\s\S]*?)<\/style>/g;
const MODULE_SCRIPT =
  /<script\b[^>]*\btype="module"[^>]*\bsrc="\/components\/[^"]*"[^>]*><\/script>/g;
const PRELOAD = /<link\b[^>]*\brel="modulepreload"[^>]*\bhref="\/components\/[^"]*"[^>]*>/g;

/**
 * An HTML page reduced to what must be equal. Each `<style>` block, component module script and
 * modulepreload link is replaced by a marker in place (so their positions and counts must match). What
 * the markers stood for is kept apart: for every style block its rules, as the chunks of CSS between
 * blank lines (Jx writes the CSS of each component as one chunk, in directory order) sorted, and the
 * module scripts and preload links sorted. So only the order of components may differ, never their
 * content.
 */
export function normalizeHtml(html) {
  const styles = [];
  const scripts = [];
  const preloads = [];
  const skeleton = html
    .replace(STYLE, (_m, open, css) => {
      styles.push(
        css
          .trim()
          .split(/\n{2,}/)
          .sort(),
      );
      return `${open}</style>`;
    })
    .replace(MODULE_SCRIPT, (m) => (scripts.push(m), "<module/>"))
    .replace(PRELOAD, (m) => (preloads.push(m), "<preload/>"));
  return { skeleton, styles, scripts: scripts.sort(), preloads: preloads.sort() };
}

/** Every file below `root` as `/`-separated relative paths, sorted; a symbolic link is reported, never followed. */
export function listFiles(root) {
  const files = [];
  const links = [];
  const visit = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = `${prefix}${entry.name}`;
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink() || lstatSync(path).isSymbolicLink()) links.push(rel);
      else if (entry.isDirectory()) visit(path, `${rel}/`);
      else files.push(rel);
    }
  };
  visit(root, "");
  return { files: files.sort(), links: links.sort() };
}

/** A short excerpt around the first difference of two strings, for a human. */
function excerpt(a, b) {
  let at = 0;
  while (at < a.length && at < b.length && a[at] === b[at]) at++;
  const cut = (text) => JSON.stringify(text.slice(Math.max(0, at - 40), at + 80));
  return `first difference at character ${at}: A ${cut(a)} / B ${cut(b)}`;
}

/** Why two HTML pages differ, or null when they are equal after the order normalization. */
function htmlDifference(a, b) {
  const na = normalizeHtml(a);
  const nb = normalizeHtml(b);
  if (na.skeleton !== nb.skeleton) return `the page differs: ${excerpt(na.skeleton, nb.skeleton)}`;
  for (const part of ["scripts", "preloads"]) {
    if (na[part].length !== nb[part].length) {
      return `${part}: A has ${na[part].length}, B has ${nb[part].length}`;
    }
    const at = na[part].findIndex((tag, i) => tag !== nb[part][i]);
    if (at !== -1)
      return `a ${part.replace(/s$/, "")} differs: ${excerpt(na[part][at], nb[part][at])}`;
  }
  for (const [block, rulesA] of na.styles.entries()) {
    const rulesB = nb.styles[block];
    if (rulesA.length !== rulesB.length) {
      return `style block ${block + 1}: A has ${rulesA.length} chunk(s) of CSS, B has ${rulesB.length}`;
    }
    const at = rulesA.findIndex((chunk, i) => chunk !== rulesB[i]);
    if (at !== -1) return `style block ${block + 1} differs: ${excerpt(rulesA[at], rulesB[at])}`;
  }
  return null;
}

/**
 * Compares two folders. Returns the files of each side, the differences (`{ path, kind, detail }` with
 * kind `only-a`, `only-b`, `content`, `symlink`), the allowed ones, and the vendored bundles skipped.
 */
export function compareDist(a, b, o = {}) {
  const allow = new Set(o.allow ?? []);
  const skipVendored =
    o.vendored === "skip" ||
    (o.vendored !== "compare" && o.runtimeA && o.runtimeB && o.runtimeA !== o.runtimeB);
  const left = listFiles(a);
  const right = listFiles(b);
  const inB = new Set(right.files);
  const inA = new Set(left.files);
  const differences = [];
  const allowed = [];
  const skipped = [];
  const record = (entry) => (allow.has(entry.path) ? allowed.push(entry) : differences.push(entry));
  for (const path of left.links)
    differences.push({ path, kind: "symlink", detail: "a symbolic link in A" });
  for (const path of right.links)
    differences.push({ path, kind: "symlink", detail: "a symbolic link in B" });
  for (const path of [...new Set([...left.files, ...right.files])].sort()) {
    if (!inB.has(path)) {
      record({ path, kind: "only-a", detail: "only in A" });
      continue;
    }
    if (!inA.has(path)) {
      record({ path, kind: "only-b", detail: "only in B" });
      continue;
    }
    const bytesA = readFileSync(join(a, path));
    const bytesB = readFileSync(join(b, path));
    if (VENDORED.test(path) && skipVendored) {
      skipped.push(path);
      continue;
    }
    if (bytesA.equals(bytesB)) continue;
    if (path.endsWith(".html")) {
      const detail = htmlDifference(bytesA.toString("utf8"), bytesB.toString("utf8"));
      if (detail === null) continue; // only the order of component blocks differs
      record({ path, kind: "content", detail });
    } else {
      const textual = /\.(?:css|js|json|svg|xml|txt|html)$|^CNAME$/.test(path);
      const detail = textual
        ? excerpt(bytesA.toString("utf8"), bytesB.toString("utf8"))
        : `binary files differ (${bytesA.length} and ${bytesB.length} bytes)`;
      record({ path, kind: "content", detail });
    }
  }
  return {
    filesA: left.files.length,
    filesB: right.files.length,
    differences,
    allowed,
    skipped,
    equal: differences.length === 0,
  };
}

function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        allow: { type: "string", multiple: true },
        "runtime-a": { type: "string" },
        "runtime-b": { type: "string" },
        vendored: { type: "string" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    console.error(`compare-dist: ${error.message}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help || positionals.length !== 2) {
    const out = values.help ? console.log : console.error;
    out(
      "usage: node scripts/compare-dist.mjs <dist-a> <dist-b> [--allow <path>]... [--runtime-a node|bun]\n" +
        "         [--runtime-b node|bun] [--vendored auto|compare|skip] [--json]",
    );
    return values.help ? 0 : 2;
  }
  for (const [flag, ok] of [
    ["runtime-a", ["node", "bun"]],
    ["runtime-b", ["node", "bun"]],
    ["vendored", ["auto", "compare", "skip"]],
  ]) {
    if (values[flag] !== undefined && !ok.includes(values[flag])) {
      console.error(`compare-dist: --${flag} must be one of ${ok.join(", ")}`);
      return 2;
    }
  }
  const [a, b] = positionals.map((p) => resolve(p));
  for (const dir of [a, b]) {
    try {
      if (!lstatSync(dir).isDirectory()) throw new Error("not a directory");
    } catch {
      console.error(`compare-dist: ${dir} is not a folder`);
      return 2;
    }
  }
  const result = compareDist(a, b, {
    allow: values.allow,
    runtimeA: values["runtime-a"],
    runtimeB: values["runtime-b"],
    vendored: values.vendored ?? "auto",
  });
  const log = values.json ? console.error : console.log;
  for (const d of result.differences) log(`DIFF  ${d.path}  (${d.detail})`);
  for (const d of result.allowed) log(`allowed  ${d.path}  (${d.detail})`);
  for (const path of result.skipped)
    log(`skipped  ${path}  (vendored bundle, builds ran on different runtimes)`);
  log(
    `compare-dist: ${result.filesA} file(s) in A, ${result.filesB} in B, ${result.differences.length} difference(s)` +
      `${result.allowed.length ? `, ${result.allowed.length} allowed` : ""}` +
      `${result.skipped.length ? `, ${result.skipped.length} vendored bundle(s) skipped` : ""}: ` +
      `${result.equal ? "identical" : "DIFFERENT"}`,
  );
  if (values.json) console.log(JSON.stringify(result, null, 2));
  return result.equal ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
