#!/usr/bin/env node
// Packs the package, installs the tarball into a copy of examples/basic exactly as a consuming repository
// would, and builds the example with the installed command line. What is tested is what would be
// published, not the working tree.
//
//   node scripts/test-pack.mjs [--pm npm|bun] [--runtime node|bun] [--linker hoisted|isolated]
//                              [--workspace] [--tarball <file>] [--keep <dir>] [--doctor] [--init]
//
//   --pm         The installer: npm (default) or bun.
//   --runtime    What runs the installed `docusystem`: node (default, the node that runs this script) or
//                bun (`bun --bun ./node_modules/.bin/docusystem`).
//   --linker     hoisted (default) or isolated (bun only: `npm --install-strategy=linked` fails on
//                esbuild's platform binary and is unsupported).
//   --workspace  Put the shell in an npm-workspaces monorepo (the root package.json lists docs-site), where
//                hoisting moves @jxsuite/* up the tree.
//   --tarball    Use this tarball instead of packing the working tree (the CI matrix builds the tarball
//                once, with Node 24, and switches the row's Node in afterwards).
//   --keep       Copy the consumer repository to this folder when the run ends, also when it failed.
//   --doctor     Also run `docusystem doctor` in the consumer and require exit 0.
//   --init       Also run `docusystem init` in a copy of the example without its shell, and require that it
//                writes the example's shell: the example is "exactly as init writes it".
//
// The steps (section 9.3 of the architecture record): pack; check that the example's shell is thin (one
// dependency, three files); copy it to a temporary directory, `git init` it with an `origin` remote and
// commit; point the dependency at the tarball; install with scripts off; run `CI=true docusystem check
// --ci` (and look at the step summary and outputs it writes); run `build` over the result; assert the
// output with scripts/assert-dist.mjs, against expectations derived from the example's Markdown; and
// assert that `git status` shows nothing but the lockfile.
//
// Exit codes: 0 passed; 1 a step or an assertion failed; 2 usage error.
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { parse as parseYaml } from "yaml";

const ROOT = resolve(import.meta.dirname, "..");
const EXAMPLE = join(ROOT, "examples", "basic");
const PACKAGE = "@avunu/docusystem";

/** The files a thin shell consists of (section 2.1): nothing else may be in the example's site folder. */
export const SHELL_FILES = [".gitignore", "docusystem.config.json", "package.json"];

const ALERT = /^\s*>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i;
const IMAGE_EXTENSION = /\.(?:png|jpe?g|gif|webp|avif|svg)$/i;

// ---- what the example's Markdown says the site must contain ----

/** Every Markdown file below `dir`, as `/`-separated paths relative to it, sorted. */
function markdownFiles(dir, prefix = "") {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith("."))
    .flatMap((entry) =>
      entry.isDirectory()
        ? markdownFiles(join(dir, entry.name), `${prefix}${entry.name}/`)
        : entry.name.endsWith(".md")
          ? [`${prefix}${entry.name}`]
          : [],
    )
    .sort();
}

/** `/docs/guide/install/` for `guide/install.md`, `/docs/` for `README.md`, `/docs/guide/` for `guide/index.md`. */
export function routeOfMarkdown(rel) {
  const parts = rel.replace(/\.md$/i, "").split("/");
  if (/^(?:readme|index)$/i.test(parts.at(-1))) parts.pop();
  return `/docs/${parts.join("/")}${parts.length > 0 ? "/" : ""}`;
}

/** The text of a Markdown file without its front matter and without fenced code. */
function proseOf(text) {
  const body = text.replace(/^(?:\s*<!--[\s\S]*?-->\s*)?---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
  const lines = [];
  let fence = null;
  for (const line of body.split(/\r?\n/)) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence === null && marker) fence = marker[1];
    else if (
      fence !== null &&
      marker &&
      marker[1][0] === fence[0] &&
      marker[1].length >= fence.length
    ) {
      fence = null;
    } else if (fence === null) lines.push(line);
  }
  return lines.join("\n");
}

/** The `title:` of a page's front matter, else its first heading. */
function titleOf(text) {
  const front = /^(?:\s*<!--[\s\S]*?-->\s*)?---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text)?.[1] ?? "";
  const title = /^title:\s*(.+?)\s*$/m.exec(front)?.[1];
  if (title) return title.replace(/^(["'])(.*)\1$/, "$2");
  return /^#\s+(.+?)\s*$/m.exec(proseOf(text))?.[1];
}

/**
 * What the example's Markdown says the built site must contain, derived from the source and not from
 * the build: the number of pages and of GitHub alerts, every page's title, and the address of every
 * link and image that leaves `docs/` (a file or folder of the repository becomes a GitHub address on the
 * branch) or stays in it (another page: its route with the anchor), plus each page's edit link.
 *
 * @param {{ root: string, docs?: string, repo: string, branch?: string, name: string }} o
 */
export function deriveExpectations(o) {
  const docsDir = resolve(o.root, o.docs ?? "docs");
  const branch = o.branch ?? "main";
  const files = markdownFiles(docsDir);
  const hrefs = new Set();
  const srcs = new Set();
  const titles = [];
  let alerts = 0;
  for (const rel of files) {
    const file = join(docsDir, ...rel.split("/"));
    const text = readFileSync(file, "utf8");
    const route = routeOfMarkdown(rel);
    // The page template names a page whose title is the project's own name just "Documentation".
    const title = titleOf(text);
    if (title !== undefined) {
      titles.push([
        route,
        `${title.toLowerCase() === o.name.toLowerCase() ? "Documentation" : title} · ${o.name}`,
      ]);
    }
    hrefs.add(`${o.repo}/edit/${branch}/${relative(o.root, file).split(sep).join("/")}`);
    const prose = proseOf(text);
    alerts += prose.split("\n").filter((line) => ALERT.test(line)).length;
    for (const m of prose
      .replace(/`[^`\n]*`/g, "")
      .matchAll(/(!?)\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const [, bang, target] = m;
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(target)) continue;
      const [pathPart, fragment] = target.split("#");
      const resolved = resolve(dirname(file), decodeURIComponent(pathPart));
      const hash = fragment === undefined ? "" : `#${fragment}`;
      const inDocs = resolved === docsDir || resolved.startsWith(`${docsDir}${sep}`);
      if (inDocs) {
        const inner = relative(docsDir, resolved).split(sep).join("/");
        if (/\.md$/i.test(inner)) hrefs.add(`${routeOfMarkdown(inner)}${hash}`);
        continue; // an image or other file of docs/ is published by the build under an address of its own
      }
      if (!resolved.startsWith(`${resolve(o.root)}${sep}`)) continue;
      const inRepo = relative(o.root, resolved).split(sep).join("/");
      const kind = statSync(resolved).isDirectory()
        ? "tree"
        : bang && IMAGE_EXTENSION.test(inRepo)
          ? "raw"
          : "blob";
      (bang ? srcs : hrefs).add(`${o.repo}/${kind}/${branch}/${inRepo}${hash}`);
    }
  }
  return { pages: files.length, alerts, titles, hrefs: [...hrefs].sort(), srcs: [...srcs].sort() };
}

// ---- the run ----

const OPTIONS = {
  pm: { type: "string" },
  runtime: { type: "string" },
  linker: { type: "string" },
  workspace: { type: "boolean" },
  tarball: { type: "string" },
  keep: { type: "string" },
  doctor: { type: "boolean" },
  init: { type: "boolean" },
  help: { type: "boolean", short: "h" },
};

const USAGE =
  "usage: node scripts/test-pack.mjs [--pm npm|bun] [--runtime node|bun] [--linker hoisted|isolated]\n" +
  "         [--workspace] [--tarball <file>] [--keep <dir>] [--doctor] [--init]";

/** Parses and validates the command line; returns `{ error }` for a usage error. */
export function parseOptions(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: false });
  } catch (error) {
    return { error: error.message };
  }
  const v = parsed.values;
  if (v.help) return { help: true };
  const pm = v.pm ?? "npm";
  const runtime = v.runtime ?? "node";
  const linker = v.linker ?? "hoisted";
  if (!["npm", "bun"].includes(pm)) return { error: `--pm must be npm or bun, not ${pm}` };
  if (!["node", "bun"].includes(runtime))
    return { error: `--runtime must be node or bun, not ${runtime}` };
  if (!["hoisted", "isolated"].includes(linker)) {
    return { error: `--linker must be hoisted or isolated, not ${linker}` };
  }
  if (pm === "npm" && linker === "isolated") {
    return {
      error: "--linker isolated needs --pm bun (npm --install-strategy=linked is unsupported)",
    };
  }
  return {
    pm,
    runtime,
    linker,
    workspace: v.workspace === true,
    tarball: v.tarball === undefined ? undefined : resolve(v.tarball),
    keep: v.keep === undefined ? undefined : resolve(v.keep),
    doctor: v.doctor === true,
    init: v.init === true,
  };
}

/** The environment a child process gets: ours, minus everything that would change what the CLI does. */
function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const name of [
    "DOCUSYSTEM_WORKFLOW_CONTRACT",
    "DOCUSYSTEM_LENIENT",
    "DOCUSYSTEM_BRANCH",
    "DOCUSYSTEM_CATALOG_URL",
    "GITHUB_ACTIONS",
    "GITHUB_STEP_SUMMARY",
    "GITHUB_OUTPUT",
    "NO_COLOR",
  ]) {
    delete env[name];
  }
  return { ...env, ...extra };
}

/** The placeholder commit of the example's callers, and the placeholder version of an unreleased package. */
const PLACEHOLDER_SHA = "0".repeat(40);

/**
 * What `docusystem init` writes into a copy of the example without its shell, against the example's own
 * files. Returns the differences, one sentence each. The version comment of the pins (`# v0.0.0`) and the
 * dependency range follow the installed package, so they are not compared.
 */
export function compareWithInit(initRoot, exampleRoot) {
  const differences = [];
  const text = (root, file) => {
    try {
      return readFileSync(join(root, ...file.split("/")), "utf8");
    } catch {
      return null;
    }
  };
  const both = (file, normalize = (value) => value) => {
    const wrote = text(initRoot, file);
    const have = text(exampleRoot, file);
    if (wrote === null) differences.push(`init did not write ${file}`);
    else if (have === null) differences.push(`the example has no ${file}`);
    else return [normalize(wrote), normalize(have)];
    return null;
  };
  const same = (file, normalize) => {
    const pair = both(file, normalize);
    if (pair && !isDeepStrictEqual(pair[0], pair[1])) {
      differences.push(
        `${file} differs from what init writes:\n--- init\n${pair[0]}\n--- example\n${pair[1]}`,
      );
    }
  };
  const json = (value) => {
    const data = JSON.parse(value);
    if (data.dependencies?.[PACKAGE]) data.dependencies[PACKAGE] = "<range>";
    return data;
  };
  same("docs-site/docusystem.config.json", JSON.parse);
  same("docs-site/package.json", json);
  same("docs-site/.gitignore");
  for (const workflow of ["docs.yml", "docs-publish.yml"]) {
    same(`.github/workflows/${workflow}`, (value) =>
      value.replace(/# v\d+\.\d+\.\d+/g, "# v<version>"),
    );
  }
  same(".github/dependabot.yml", parseYaml);
  return differences;
}

function main(argv) {
  const options = parseOptions(argv);
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  if (options.error) {
    console.error(`test-pack: ${options.error}\n${USAGE}`);
    return 2;
  }
  const { pm, runtime, linker, workspace } = options;
  // a real path: the command line prints the paths it works with, and on macOS /var is a link to /private/var
  const work = realpathSync(
    mkdtempSync(join(process.env.DOCUSYSTEM_TMP ?? tmpdir(), "docusystem-pack-")),
  );
  const fail = (message) => {
    throw new Error(message);
  };
  const run = (command, args, cwd, env = {}) => {
    console.log(`$ ${command} ${args.join(" ")}   (${cwd.replace(work, "<tmp>")})`);
    const result = spawnSync(command, args, {
      cwd,
      stdio: "inherit",
      env: cleanEnv(env),
      timeout: 15 * 60 * 1000,
    });
    if (result.status !== 0) {
      fail(
        `${command} ${args.join(" ")} exited with ${result.status ?? result.signal ?? result.error}`,
      );
    }
  };
  const capture = (command, args, cwd) =>
    execFileSync(command, args, { cwd, encoding: "utf8", env: cleanEnv() }).trim();
  const consumer = join(work, "consumer");
  let ok = false;

  try {
    // 1. the tarball
    let tarball = options.tarball;
    if (tarball === undefined) {
      const [packed] = JSON.parse(
        execFileSync("npm", ["pack", "--json", "--pack-destination", work], {
          cwd: ROOT,
          encoding: "utf8",
          env: cleanEnv(),
          stdio: ["ignore", "pipe", "inherit"],
        }),
      );
      tarball = join(work, packed.filename);
    } else if (!existsSync(tarball)) fail(`${tarball} does not exist`);
    const packedVersion = JSON.parse(
      capture("tar", ["-xzOf", tarball, "package/package.json"], work),
    ).version;
    console.log(`test-pack: ${tarball.replace(work, "<tmp>")} (${PACKAGE} ${packedVersion})`);

    // 2. the shell is thin: one dependency of ours, three files, nothing a shell must not contain
    const exampleSite = join(EXAMPLE, "docs-site");
    const shellFiles = readdirSync(exampleSite).filter(
      (f) => !["node_modules", "dist", ".docusystem"].includes(f),
    );
    if (JSON.stringify(shellFiles.sort()) !== JSON.stringify(SHELL_FILES)) {
      fail(
        `the example's docs-site should hold exactly ${SHELL_FILES.join(", ")}, not ${shellFiles.join(", ")}`,
      );
    }
    const exampleManifest = JSON.parse(readFileSync(join(exampleSite, "package.json"), "utf8"));
    const dependencies = Object.keys(exampleManifest.dependencies ?? {});
    if (dependencies.length !== 1 || dependencies[0] !== PACKAGE) {
      fail(
        `the example's dependencies should be exactly ${PACKAGE}, got ${dependencies.join(", ") || "none"}`,
      );
    }
    if (
      exampleManifest.devDependencies ||
      exampleManifest.scripts?.postinstall ||
      exampleManifest.scripts?.prepare
    ) {
      fail("the example's package.json has devDependencies or an install script");
    }
    const config = JSON.parse(readFileSync(join(exampleSite, "docusystem.config.json"), "utf8"));

    // 3. a consuming repository: the example, committed, with an origin remote
    const repoRoot = consumer;
    cpSync(EXAMPLE, repoRoot, {
      recursive: true,
      filter: (source) => !/(^|[\\/])(?:node_modules|dist|\.docusystem)$/.test(source),
    });
    const site = join(repoRoot, "docs-site");
    if (workspace) {
      writeFileSync(
        join(repoRoot, "package.json"),
        `${JSON.stringify({ name: "docusystem-example-monorepo", private: true, workspaces: ["docs-site"] }, null, 2)}\n`,
      );
    }
    writeFileSync(join(repoRoot, ".gitignore"), "node_modules/\n");
    const git = (...args) =>
      capture(
        "git",
        [
          "-c",
          "user.name=docusystem-test",
          "-c",
          "user.email=test@example.invalid",
          "-c",
          "commit.gpgsign=false",
          ...args,
        ],
        repoRoot,
      );
    git("init", "--quiet", "--initial-branch", "main");
    git("remote", "add", "origin", `${config.repo}.git`);
    git("add", "-A");
    git("commit", "--quiet", "-m", "the example");

    // 4. what the registry would give: the dependency is the tarball
    writeFileSync(
      join(site, "package.json"),
      `${JSON.stringify({ ...exampleManifest, dependencies: { [PACKAGE]: `file:${tarball}` } }, null, 2)}\n`,
    );
    git("commit", "--quiet", "-am", "depend on the tarball");

    // 5. install with scripts off, in the shell (or the workspace root)
    const installDir = workspace ? repoRoot : site;
    if (pm === "bun") run("bun", ["install", "--ignore-scripts", "--linker", linker], installDir);
    else run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], installDir);

    const bin = join(workspace ? repoRoot : site, "node_modules", ".bin", "docusystem");
    if (!existsSync(bin)) fail(`${bin} was not installed`);
    const launch = runtime === "bun" ? ["bun", ["--bun", bin]] : [process.execPath, [bin]];
    const docusystem = (args, env = {}) => run(launch[0], [...launch[1], ...args], site, env);

    // 6. the installed command line
    const version = capture(launch[0], [...launch[1], "--version"], site);
    console.log(`test-pack: docusystem --version prints ${version}`);
    if (version !== packedVersion)
      fail(`docusystem --version prints ${version}, the tarball is ${packedVersion}`);

    const summary = join(work, "step-summary.md");
    const outputs = join(work, "step-output.txt");
    writeFileSync(summary, "");
    writeFileSync(outputs, "");
    docusystem(["check", "--ci"], {
      CI: "true",
      GITHUB_STEP_SUMMARY: summary,
      GITHUB_OUTPUT: outputs,
    });
    // `check --ci` writes a job summary and the step outputs a workflow reads (section 4.1)
    if (readFileSync(summary, "utf8").trim() === "")
      fail("check --ci wrote nothing to $GITHUB_STEP_SUMMARY");
    const outputLines = Object.fromEntries(
      readFileSync(outputs, "utf8")
        .split(/\r?\n/)
        .filter((line) => line.includes("="))
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
    const distDir = join(site, "dist");
    for (const [key, wanted] of [
      ["dist", distDir],
      ["page-url", `https://${config.domain}/`],
    ]) {
      if (outputLines[key] !== wanted)
        fail(`$GITHUB_OUTPUT has ${key}=${outputLines[key]}, wanted ${wanted}`);
    }
    if (!/^\d+$/.test(outputLines.pages ?? ""))
      fail(`$GITHUB_OUTPUT has pages=${outputLines.pages}`);
    console.log(`test-pack: $GITHUB_OUTPUT has dist, page-url and pages=${outputLines.pages}`);

    docusystem(["build"], { CI: "true" }); // the command on its own, over the dist that check left
    if (options.doctor) docusystem(["doctor"], { CI: "true" });

    if (options.init) {
      // init, in a copy of the example without its shell, must write that shell
      const fresh = join(work, "init-check");
      cpSync(EXAMPLE, fresh, {
        recursive: true,
        filter: (source) =>
          !/(^|[\\/])(?:node_modules|dist|\.docusystem|docs-site|\.github)$/.test(source),
      });
      capture("git", ["init", "--quiet", "--initial-branch", "main"], fresh);
      capture("git", ["remote", "add", "origin", `${config.repo}.git`], fresh);
      const identity = ["slug", "name", "tagline", "platform", "license"].flatMap((key) => [
        `--${key}`,
        config[key],
      ]);
      run(launch[0], [...launch[1], "init", "--workflow-sha", PLACEHOLDER_SHA, ...identity], fresh);
      const differences = compareWithInit(fresh, EXAMPLE);
      if (differences.length > 0)
        fail(`init does not write the example:\n${differences.join("\n")}`);
      console.log("test-pack: init writes exactly the example's shell");
    }

    // 7. the output, against what the Markdown says
    const expect = deriveExpectations({ root: repoRoot, repo: config.repo, name: config.name });
    run(
      process.execPath,
      [
        join(ROOT, "scripts", "assert-dist.mjs"),
        "dist",
        "docusystem.config.json",
        "--pages",
        String(expect.pages),
        "--alerts",
        String(expect.alerts),
        ...expect.hrefs.flatMap((url) => ["--href", url]),
        ...expect.srcs.flatMap((url) => ["--src", url]),
        ...expect.titles.flatMap(([route, title]) => ["--title", `${route}=${title}`]),
      ],
      site,
    );

    // 8. nothing but the lockfile is new: .docusystem/ ignores itself, dist/ and node_modules/ are ignored
    const status = git("status", "--porcelain", "--untracked-files=all")
      .split("\n")
      .filter(Boolean);
    const lockfile = pm === "bun" ? "bun.lock" : "package-lock.json";
    const allowed = new Set([`?? ${workspace ? "" : "docs-site/"}${lockfile}`]);
    const unexpected = status.filter((line) => !allowed.has(line));
    if (unexpected.length > 0)
      fail(`git status shows more than the lockfile:\n${unexpected.join("\n")}`);
    if (status.length === 0) fail(`git status shows no ${lockfile}: was it written?`);
    console.log(`test-pack: git status shows only ${lockfile}`);

    ok = true;
    console.log(
      `test-pack: ok (pm=${pm}, runtime=${runtime}, linker=${linker}${workspace ? ", workspace" : ""})`,
    );
  } catch (error) {
    console.error(`test-pack: ${error.message}`);
  } finally {
    if (options.keep) {
      rmSync(options.keep, { recursive: true, force: true });
      mkdirSync(dirname(options.keep), { recursive: true });
      if (existsSync(consumer)) cpSync(consumer, options.keep, { recursive: true });
    }
    rmSync(work, { recursive: true, force: true });
  }
  return ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
