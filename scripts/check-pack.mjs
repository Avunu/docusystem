#!/usr/bin/env node
// Checks what `npm publish` would upload: nothing unexpected is in the tarball, everything the package
// promises is, the size has not crept up, and nothing runs when a consumer installs it. Run after
// `npm run build` (`npm pack --ignore-scripts` is used on purpose: the check inspects the build, it
// does not make one). The rules are section 3.4 of the architecture decision record.
//
//   node scripts/check-pack.mjs
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The size budget: packed and unpacked bytes, and the number of files. The bytes are the record's
 * (the prototypes measured 205 KB packed). The record's 120 files assumed the prototypes' 93; the
 * package as WP0 laid it out compiles 49 modules to 98 files in dist/ alone (a .js and a .d.ts each),
 * and with the 32 files of site/ and the scaffold it is about 140. 200 leaves room for the packages
 * still to land while the allowlist above, not the count, is what keeps strays out.
 */
export const BUDGET = { packed: 400 * 1024, unpacked: 1_200 * 1024, files: 200 };

/** Every file in the tarball must match one of these. */
export const ALLOWED = [
  /^package\.json$/,
  /^README\.md$/,
  /^LICENSE$/,
  /^CHANGELOG\.md$/,
  /^config\.schema\.json$/,
  /^dist\/.+\.(?:js|d\.ts)$/,
  /^site\/.+/,
  /^scaffold\/[\w.-]+$/,
];

/** Every one of these must be in the tarball. */
export const REQUIRED = [
  "package.json",
  "README.md",
  "LICENSE",
  "config.schema.json",
  "dist/cli.js",
  "dist/index.js",
  "dist/index.d.ts",
  "site/project.base.json",
  "site/layouts/base.json",
  "site/public/fonts/LICENSE-Figtree.txt",
  "site/data/projects.snapshot.json",
  "scaffold/docs.yml",
  "scaffold/docs-publish.yml",
  "scaffold/dependabot-npm.yml",
  "scaffold/dependabot-actions.yml",
  "scaffold/gitignore",
];

/** None of these may be in the tarball, even where an allowed pattern would let them through. */
export const FORBIDDEN = [
  /\.(?:test|spec)\.(?:[cm]?js|ts)$/,
  /(?:^|\/)__tests__\//,
  /(?:^|\/)node_modules\//,
  /\.tsbuildinfo$/,
  /(?:^|\/)\.env/,
  /\.tgz$/,
  /\.map$/,
  /(?:^|\/)bun\.lockb?$/,
  /(?:^|\/)workflow-ref\.json$/,
  /(?:^|\/)legacy\//,
];

/** Lifecycle scripts that would run on a consumer's machine when the package is installed. */
export const INSTALL_HOOKS = ["preinstall", "install", "postinstall", "prepare", "prepublish"];

/**
 * Problems with a tarball, one sentence each. `paths` are the files `npm pack` lists (`/`-separated),
 * `size` and `unpackedSize` its bytes, `scripts` the `scripts` of the packed package.json.
 */
export function problemsWith({ paths, size, unpackedSize, scripts = {} }) {
  const problems = [];
  for (const path of paths) {
    if (!ALLOWED.some((pattern) => pattern.test(path))) {
      problems.push(`unexpected file in the tarball: ${path}`);
    }
    if (FORBIDDEN.some((pattern) => pattern.test(path))) {
      problems.push(`forbidden file in the tarball: ${path}`);
    }
  }
  for (const path of REQUIRED) {
    if (!paths.includes(path)) problems.push(`missing from the tarball: ${path}`);
  }
  if (size > BUDGET.packed) {
    problems.push(`tarball is ${size} bytes, over the ${BUDGET.packed} budget`);
  }
  if (unpackedSize > BUDGET.unpacked) {
    problems.push(`unpacked size is ${unpackedSize} bytes, over the ${BUDGET.unpacked} budget`);
  }
  if (paths.length > BUDGET.files) {
    problems.push(`${paths.length} files, over the ${BUDGET.files} budget`);
  }
  for (const hook of INSTALL_HOOKS) {
    if (Object.hasOwn(scripts, hook)) {
      problems.push(`package.json has a "${hook}" script: nothing may run at install time`);
    }
  }
  return problems;
}

/** Packs the working tree without running scripts (a dry run: nothing is written) and checks it. */
function main() {
  const [pack] = JSON.parse(
    execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { encoding: "utf8" }),
  );
  const paths = pack.files.map((file) => file.path);
  const { scripts } = JSON.parse(readFileSync("package.json", "utf8"));
  const problems = problemsWith({
    paths,
    size: pack.size,
    unpackedSize: pack.unpackedSize,
    scripts,
  });

  console.log(
    `${pack.name}@${pack.version}: ${paths.length} files, ${pack.size} bytes packed, ${pack.unpackedSize} unpacked`,
  );
  for (const problem of problems) console.error(`check-pack: ${problem}`);
  process.exit(problems.length > 0 ? 1 : 0);
}

// `import.meta.main` exists only on Node 24.2+; this must also run (and not silently pass) on 22.
if (
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
