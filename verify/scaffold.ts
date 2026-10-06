// Scaffolds a throwaway adopting repository and builds it with the PACKED package, the way a consuming
// repository would: install the tarball, run `docusystem check` (the checks CI runs), and leave the built
// site where the browser suites can read it. Two kinds of sandbox:
//
//   bun scaffold.ts --sandbox <dir> --tarball <file> --example [--slug s] [--name n] [--domain d] ...
//       A copy of examples/basic, with the identity keys of its docusystem.config.json overridden by the
//       options given. This is what axe, drawer, shots and fences run on, and (with --slug set to a real
//       catalog slug) what switcher runs on, so that its "You are here" state exists.
//
//   bun scaffold.ts --sandbox <dir> --tarball <file> --doc README.md=<file> --repo-files <folder> \
//       --name Sandbox --tagline "..." --license MIT --repo https://github.com/Avunu/sandbox --slug sandbox
//       An empty repository with a hand-written shell (the three files of a thin shell, from the identity
//       keys given; `init` is not involved, so that this tests the documents and not the inference): the
//       Markdown given by --doc becomes docs/, the files of each --repo-files folder become the repository
//       root (source files, LICENSE, its own README.md) so that links to them can be checked. This is what
//       edge runs on.
//
//   --sandbox     the folder to create; it is replaced when a previous run of this script made it
//   --tarball     the packed package (`npm pack`)
//   --example     the first kind of sandbox
//   --doc         DEST=SOURCE, repeatable: copies SOURCE to docs/DEST
//   --repo-files  repeatable: a folder whose files become the repository root; .git, node_modules, result and
//                 logs are skipped
//   --branch      the repository's default branch, as a clone would know it (origin/HEAD); default: none
//   --name --tagline --platform --repo --license --slug --domain   the identity keys: overrides in the first
//                 kind of sandbox, the values of the config file in the second (platform defaults to
//                 general, domain to <slug>.avunu.net; the others are required)
//   --no-check    stop after the install (no build)
//   --lenient     build with `docusystem build --lenient` instead of the strict `CI=true docusystem check`
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const MARKER = ".docusystem-verify-sandbox";
const IDENTITY = ["name", "tagline", "platform", "repo", "license", "slug", "domain"] as const;
const example = resolve(import.meta.dirname, "..", "examples", "basic");

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    sandbox: { type: "string" },
    tarball: { type: "string" },
    example: { type: "boolean" },
    doc: { type: "string", multiple: true },
    "repo-files": { type: "string", multiple: true },
    name: { type: "string" },
    tagline: { type: "string" },
    platform: { type: "string" },
    repo: { type: "string" },
    license: { type: "string" },
    slug: { type: "string" },
    domain: { type: "string" },
    branch: { type: "string" },
    "no-check": { type: "boolean" },
    lenient: { type: "boolean" },
  },
});
if (!values.sandbox || !values.tarball) {
  console.error(
    "usage: bun scaffold.ts --sandbox <dir> --tarball <file> (--example | --doc DEST=SOURCE ...) [options]\n(see the top of this file)",
  );
  process.exit(2);
}
const sandbox = resolve(values.sandbox);
const tarball = resolve(values.tarball);
if (!existsSync(tarball)) {
  console.error(`scaffold: ${tarball} does not exist`);
  process.exit(2);
}
if (!values.example && (values.doc ?? []).length === 0) {
  console.error("scaffold: give --example or at least one --doc");
  process.exit(2);
}

if (existsSync(sandbox)) {
  if (existsSync(join(sandbox, MARKER))) rmSync(sandbox, { recursive: true, force: true });
  else if (readdirSync(sandbox).length > 0) {
    console.error(
      `${sandbox} exists and was not made by this script (no ${MARKER}); refusing to touch it`,
    );
    process.exit(2);
  }
}
mkdirSync(sandbox, { recursive: true });
writeFileSync(join(sandbox, MARKER), "made by verify/scaffold.ts\n");

const run = (command: string, args: string[], cwd: string, env: Record<string, string> = {}) => {
  console.log(`$ ${command} ${args.join(" ")}   (in ${cwd.replace(sandbox, "<sandbox>")})`);
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) {
    console.error(`scaffold: ${command} ${args.join(" ")} failed`);
    process.exit(result.status ?? 1);
  }
};
const git = (...args: string[]) =>
  run(
    "git",
    ["-c", "user.name=verify", "-c", "user.email=verify@example.invalid", ...args],
    sandbox,
  );

const site = join(sandbox, "docs-site");
const keep = (src: string) =>
  !/(^|[\\/])(\.git|node_modules|dist|\.docusystem|result|logs)$/.test(src);
let repo = values.repo;

git("init", "-q", "-b", "feature/docs-site");
if (values.example) {
  // 1. the example, with its identity keys overridden
  cpSync(example, sandbox, { recursive: true, filter: keep });
  const configFile = join(site, "docusystem.config.json");
  const config = JSON.parse(readFileSync(configFile, "utf8")) as Record<string, string>;
  for (const key of IDENTITY) if (values[key] !== undefined) config[key] = values[key];
  if (values.slug !== undefined && values.domain === undefined) {
    config.domain = `${values.slug.replaceAll("_", "-")}.avunu.net`;
  }
  writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
  repo = config.repo;
} else {
  // 1. an empty repository with the given files
  for (const folder of values["repo-files"] ?? []) {
    cpSync(resolve(folder), sandbox, { recursive: true, filter: keep });
  }
  for (const spec of values.doc ?? []) {
    const [dest, source] = spec.split("=");
    if (!dest || !source) throw new Error(`--doc wants DEST=SOURCE, got ${spec}`);
    const target = join(sandbox, "docs", dest);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(resolve(source), target, { recursive: true });
  }
}
if (repo) git("remote", "add", "origin", `${repo}.git`);
if (repo && values.branch) {
  git("symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${values.branch}`);
}

const useTarball = () => {
  const file = join(site, "package.json");
  const manifest = JSON.parse(readFileSync(file, "utf8")) as Record<string, any>;
  manifest.dependencies = { ...manifest.dependencies, "@avunu/docusystem": `file:${tarball}` };
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
};

if (!values.example) {
  // 2. a thin shell, written by hand
  const missing = (["name", "tagline", "repo", "license", "slug"] as const).filter(
    (k) => !values[k],
  );
  if (missing.length > 0) {
    console.error(`scaffold: give ${missing.map((k) => `--${k}`).join(", ")}`);
    process.exit(2);
  }
  const slug = values.slug as string;
  mkdirSync(site, { recursive: true });
  const config = {
    $schema: "./node_modules/@avunu/docusystem/config.schema.json",
    name: values.name,
    tagline: values.tagline,
    slug,
    platform: values.platform ?? "general",
    repo: values.repo,
    domain: values.domain ?? `${slug.replaceAll("_", "-")}.avunu.net`,
    license: values.license,
  };
  writeFileSync(join(site, "docusystem.config.json"), `${JSON.stringify(config, null, 2)}\n`);
  const manifest = {
    name: `${slug.replaceAll("_", "-")}-docs`,
    private: true,
    type: "module",
    scripts: { dev: "docusystem dev", build: "docusystem build", check: "docusystem check" },
    dependencies: { "@avunu/docusystem": "^0.1.0" },
  };
  writeFileSync(join(site, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(site, ".gitignore"), "node_modules/\ndist/\n.docusystem/\n");
}
// 3. the dependency is the tarball; install with scripts off
useTarball();
run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], site);

// 4. build: the checks CI runs, or a lenient build. The CLI runs on Node, as the deployed build does
// (these scripts run on Bun, but the site they test is built by the runtime the workflow uses).
const bin = join(site, "node_modules", ".bin", "docusystem");
if (!values["no-check"]) {
  if (values.lenient) run("node", [bin, "build", "--lenient"], site);
  else run("node", [bin, "check"], site, { CI: "true" });
}

const dist = join(site, ".docusystem", "site", "dist");
console.log(`\nscaffold: done. The site is ${site}`);
console.log(`the Jx output the suites read: ${dist}`);
console.log(
  `next:\n  bun axe.ts ${dist}\n  bun drawer.ts ${dist}\n  bun shots.ts ${dist} <outDir>`,
);
console.log(
  `  bun fences.ts ${site}\n  bun edge.ts ${join(site, "dist")}   (the edge-case sandbox)`,
);
