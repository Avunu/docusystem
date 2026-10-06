#!/usr/bin/env node
// The pilot equivalence rehearsal (section 9.7 of the architecture decision record): proves, before any
// pilot is touched, that the migration (scripts/migrate-pilot.mjs) and the package give each pilot the same
// documentation site as the starter copy it has today. Dev-only; it changes nothing in any pilot or in a
// clone of yours: everything happens in fresh clones in a work folder.
//
//   node scripts/rehearse-pilots.mjs [options]
//
// For each pilot (frappe-nix, erpnext_taskview, cloudflare-email-relay):
//
//   1. clone       a fresh clone of the pilot's branch docs/project-docs-site (the default branch when that
//                  branch has been merged and deleted), which must still carry the starter's docs-site/.
//   2. baseline    build the documentation with the pilot's own starter: `bun install --frozen-lockfile`
//                  against its own lockfile, then `CI=true bun run build`.
//   3. migrate     a second clone of the first; `migrate-pilot.mjs` in dry-run mode, then with --write; then
//                  `git status` must show exactly what section 10.4 describes: the starter's files deleted
//                  (everything in docs-site/ but package.json and .gitignore), five files modified, two
//                  created.
//   4. install     `npm install` from the PACKED TARBALL (the dependency of the shell is pointed at it).
//   5. check       `CI=true docusystem check --ci` and `docusystem doctor` (no error) in the shell.
//   6. compare     scripts/compare-dist.mjs over the two dist/ folders: zero differing files except
//                  components/docs-enhance.js (the intentional 1px fix), the same set of files, the same
//                  number of search-index documents. The three vendored bundles are compared byte for byte
//                  only when the thin build ran on Bun too (--runtime bun); Bun's bundler minifies them
//                  differently from esbuild on Node.
//
// Options:
//   --pilot <name>             Only this pilot. Repeatable. Default: all three.
//   --source <name>=<url|dir>  Clone this pilot from here. Default: https://github.com/Avunu/<name>.git
//   --tarball <file>           The packed package. Default: `npm pack` of this working tree (prepack builds it).
//   --runtime <node|bun>       What runs the shell's docusystem. Default: node.
//   --workflow-sha <sha>       The commit the migrated callers are pinned to. Default: the placeholder
//                              commit of 40 zeros (the rehearsal never runs the workflows).
//   --work <dir>               Work in this folder (created if needed). Default: a temporary folder.
//   --keep                     Keep the work folder and print where it is.
//   --json <file>              Also write the results as JSON.
//
// Needs network access (clones, `bun install`, `npm install`), git, Bun and npm. The migration uses the
// package's helpers as built: run `npm run build` first when you pass --tarball.
//
// Exit codes: 0 every pilot passed every step; 1 a pilot failed; 2 usage error.
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { compareDist } from "./compare-dist.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const PACKAGE = "@avunu/docusystem";
export const SITE = "docs-site";
/** The branch of each pilot's pull request that carries the starter. */
export const PILOT_BRANCH = "docs/project-docs-site";
export const PILOTS = [
  { name: "frappe-nix", url: "https://github.com/Avunu/frappe-nix.git" },
  { name: "erpnext_taskview", url: "https://github.com/Avunu/erpnext_taskview.git" },
  { name: "cloudflare-email-relay", url: "https://github.com/Avunu/cloudflare-email-relay.git" },
];
/** What may differ between the starter's build and the shell's: the intentional 1px fix of the release. */
export const ALLOWED_DIFFERENCES = ["components/docs-enhance.js"];
/** Section 10.4: what the migration modifies and creates in each pilot (the rest of docs-site/ goes). */
export const EXPECTED_MODIFIED = [
  ".github/dependabot.yml",
  ".github/workflows/dependabot-auto-merge.yml",
  ".github/workflows/docs.yml",
  `${SITE}/.gitignore`,
  `${SITE}/package.json`,
];
export const EXPECTED_CREATED = [
  ".github/workflows/docs-publish.yml",
  `${SITE}/docusystem.config.json`,
];
const STAGES = { clone: 3 * 60_000, install: 5 * 60_000, build: 5 * 60_000, check: 5 * 60_000 };

// ---- what `git status` must show after the migration ----

/**
 * What section 10.4 says `git status` shows after `migrate-pilot.mjs --write`, from the files git tracks in
 * the pilot (`tracked`, repository-relative) and the files the migration says it keeps (`kept`): every
 * tracked file of docs-site/ is deleted except package.json and .gitignore, which are rewritten, and
 * except those kept; five files are modified and two created.
 */
export function expectedStatus({ tracked, kept = [] }) {
  const rewritten = new Set([`${SITE}/package.json`, `${SITE}/.gitignore`]);
  const keptSet = new Set(kept);
  return {
    deleted: tracked
      .filter((path) => path.startsWith(`${SITE}/`) && !rewritten.has(path) && !keptSet.has(path))
      .sort(),
    modified: [...EXPECTED_MODIFIED].sort(),
    created: [...EXPECTED_CREATED].sort(),
  };
}

/** `git status --porcelain --untracked-files=all` as `{ deleted, modified, created, other }` (sorted paths). */
export function parseStatus(porcelain) {
  const out = { deleted: [], modified: [], created: [], other: [] };
  for (const line of porcelain.split("\n")) {
    if (line.trim() === "") continue;
    const code = line.slice(0, 2);
    const path = line.slice(3);
    if (code === "??") out.created.push(path);
    else if (code.includes("D")) out.deleted.push(path);
    else if (code.includes("M")) out.modified.push(path);
    else out.other.push(`${code.trim()} ${path}`);
  }
  for (const list of Object.values(out)) list.sort();
  return out;
}

/** The differences between an expected status and the actual one, as sentences; empty when they agree. */
export function statusDifferences(expected, actual) {
  const problems = [];
  for (const kind of ["deleted", "modified", "created"]) {
    const want = new Set(expected[kind]);
    const have = new Set(actual[kind]);
    for (const path of want)
      if (!have.has(path)) problems.push(`${path} should be ${kind} and is not`);
    for (const path of have)
      if (!want.has(path)) problems.push(`${path} is ${kind} and should not be`);
  }
  for (const entry of actual.other ?? []) problems.push(`unexpected status: ${entry}`);
  return problems;
}

// ---- reading output ----

/** The numbers the CLI prints: `links: 13 page(s), 978 reference(s) checked`, `Done: 13 routes`. */
export function readCheckOutput(output) {
  const links = /^links:\s+(\d+) page\(s\), (\d+) reference\(s\) checked/m.exec(output);
  const routes = /^Done:\s+(\d+) routes?/m.exec(output);
  const contrast = /^contrast:\s+(\d+) color pair\(s\) checked, (\d+) below the minimum/m.exec(
    output,
  );
  return {
    pages: links ? Number(links[1]) : null,
    references: links ? Number(links[2]) : null,
    routes: routes ? Number(routes[1]) : null,
    contrastPairs: contrast ? Number(contrast[1]) : null,
    contrastFailures: contrast ? Number(contrast[2]) : null,
    passed: /^check: all steps passed/m.test(output),
  };
}

/** The number of documents of the search index of a built site, or null when there is none. */
export function searchDocuments(dist) {
  const file = join(dist, "search-index.json");
  if (!existsSync(file)) return null;
  const index = JSON.parse(readFileSync(file, "utf8"));
  return Array.isArray(index.documents) ? index.documents.length : null;
}

// ---- running a command ----

/** Our environment minus what would change the CLI's behavior, plus `extra`. */
function cleanEnv(home, extra = {}) {
  const env = { ...process.env, HOME: home };
  for (const name of [
    "CI",
    "DOCUSYSTEM_WORKFLOW_CONTRACT",
    "DOCUSYSTEM_LENIENT",
    "DOCUSYSTEM_BRANCH",
    "DOCUSYSTEM_CATALOG_URL",
    "GITHUB_ACTIONS",
    "GITHUB_STEP_SUMMARY",
    "GITHUB_OUTPUT",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "NO_COLOR",
  ]) {
    delete env[name];
  }
  return { ...env, ...extra };
}

/** Runs a command; returns `{ code, output, stdout }` (`output` is stdout and stderr together), never throws. */
function run(command, args, { cwd, env, timeout }) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout,
    maxBuffer: 1 << 28,
  });
  const stdout = result.stdout ?? "";
  const output = `${stdout}${result.stderr ?? ""}${result.error ? `\n${result.error.message}` : ""}`;
  return { code: result.status ?? (result.signal ? 137 : 127), output, stdout };
}

const tail = (text, lines = 12) =>
  text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .slice(-lines)
    .join("\n");

// ---- one pilot ----

/** The error of a failed step: `{ stage, message }` thrown through `step`. */
class StepFailure extends Error {
  constructor(stage, message) {
    super(message);
    this.stage = stage;
  }
}

/**
 * Rehearses one pilot (everything it runs is a child process it waits for). Returns `{ name, ok, stage, ... }`; `stage` is where it stopped (`done` when
 * every step passed) and `problems` says why it did not.
 *
 * @param {{ name: string, url: string }} pilot
 * @param {{ work: string, tarball: string, runtime: string, sha: string, log: (line: string) => void }} o
 */
export function rehearse(pilot, o) {
  const started = Date.now();
  const dir = join(o.work, pilot.name);
  const home = join(dir, "home");
  const orig = join(dir, "orig"); // a clone, built with the starter
  const thin = join(dir, "thin"); // a clone of it, migrated and built with the package
  const say = (text) => o.log(`rehearse: ${pilot.name}: ${text}`);
  const result = { name: pilot.name, ok: false, stage: "clone", problems: [], seconds: 0 };
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  const gitEnv = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    LANG: "C",
  };
  const must = (stage, step, what) => {
    result.stage = stage;
    if (step.code !== 0)
      throw new StepFailure(stage, `${what} exited with ${step.code}:\n${tail(step.output)}`);
    return step;
  };
  const git = (cwd, ...args) => run("git", args, { cwd, env: gitEnv, timeout: STAGES.clone });

  try {
    // 1. a fresh clone of the pilot's branch (its default branch once that branch has been merged and removed)
    say("clone");
    let cloned = git(dir, "clone", "--quiet", "--branch", PILOT_BRANCH, pilot.url, orig);
    if (cloned.code !== 0) {
      rmSync(orig, { recursive: true, force: true });
      cloned = git(dir, "clone", "--quiet", pilot.url, orig);
    }
    must("clone", cloned, `git clone ${pilot.url}`);
    const branchText = git(
      orig,
      "symbolic-ref",
      "--short",
      "refs/remotes/origin/HEAD",
    ).output.trim();
    const defaultBranch = branchText.replace(/^origin\//, "") || "main";
    result.defaultBranch = defaultBranch;
    result.ref = git(orig, "rev-parse", "--abbrev-ref", "HEAD").output.trim();
    result.commit = git(orig, "rev-parse", "--short", "HEAD").output.trim();
    for (const needed of ["docs.config.json", "scripts/lib/stage.ts", "bun.lock"]) {
      if (!existsSync(join(orig, SITE, needed))) {
        throw new StepFailure(
          "clone",
          `${SITE}/${needed} is missing in ${pilot.url} (${result.ref}): it no longer carries the starter, so there is nothing to rehearse`,
        );
      }
    }

    // 2. the baseline: the pilot's own starter, on Bun, from its own lockfile
    say("baseline: bun install --frozen-lockfile, then the starter's strict build");
    const site = join(orig, SITE);
    must(
      "baseline",
      run("bun", ["install", "--frozen-lockfile"], {
        cwd: site,
        env: cleanEnv(home),
        timeout: STAGES.install,
      }),
      "bun install --frozen-lockfile",
    );
    const baseline = must(
      "baseline",
      run("bun", ["run", "build"], {
        cwd: site,
        env: cleanEnv(home, { CI: "true" }),
        timeout: STAGES.build,
      }),
      "the starter's build",
    );
    result.baseline = { routes: readCheckOutput(baseline.output).routes };
    const origDist = join(site, "dist");

    // 3. the migration, on a clone of the clone: nothing built, nothing installed
    say("migrate: dry run, then --write");
    must("migrate", git(dir, "clone", "--quiet", orig, thin), "git clone of the clone");
    const tracked = git(thin, "ls-files", "-z").output.split("\0").filter(Boolean);
    const migrate = (args) =>
      run(
        process.execPath,
        [join(ROOT, "scripts", "migrate-pilot.mjs"), thin, "--workflow-sha", o.sha, ...args],
        {
          cwd: ROOT,
          env: cleanEnv(home),
          timeout: STAGES.check,
        },
      );
    const dry = must("migrate", migrate(["--json"]), "migrate-pilot.mjs (dry run)");
    const plan = JSON.parse(dry.stdout);
    const kept = plan.kept.map((entry) => entry.path);
    const before = git(thin, "status", "--porcelain", "--untracked-files=all").output;
    if (before.trim() !== "")
      throw new StepFailure("migrate", `the dry run changed the clone:\n${before}`);
    must("migrate", migrate(["--write"]), "migrate-pilot.mjs --write");
    const status = parseStatus(git(thin, "status", "--porcelain", "--untracked-files=all").output);
    const differences = statusDifferences(expectedStatus({ tracked, kept }), status);
    result.migration = {
      deleted: status.deleted.length,
      modified: status.modified.length,
      created: status.created.length,
      kept,
      advice: plan.advice.length,
    };
    if (differences.length > 0) {
      throw new StepFailure(
        "migrate",
        `git status is not what section 10.4 describes:\n  ${differences.join("\n  ")}`,
      );
    }
    // the plan listed the same files that the write changed
    const listed = plan.actions.map((a) => `${a.kind}:${a.path}`).sort();
    const written = [
      ...status.deleted.map((p) => `delete:${p}`),
      ...status.modified.map((p) => `update:${p}`),
      ...status.created.map((p) => `create:${p}`),
    ].sort();
    if (JSON.stringify(listed) !== JSON.stringify(written)) {
      throw new StepFailure("migrate", "the dry run listed other files than --write changed");
    }
    // idempotence: a second --write changes nothing
    must("migrate", migrate(["--write"]), "migrate-pilot.mjs --write (again)");
    const again = git(thin, "status", "--porcelain", "--untracked-files=all").output;
    if (JSON.stringify(parseStatus(again)) !== JSON.stringify(status)) {
      throw new StepFailure("migrate", "a second --write changed the clone");
    }

    // 4. install from the packed tarball (what the registry would give)
    say("install: npm install from the packed tarball");
    const shell = join(thin, SITE);
    const manifestFile = join(shell, "package.json");
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
    manifest.dependencies = { ...manifest.dependencies, [PACKAGE]: `file:${o.tarball}` };
    writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
    must(
      "install",
      run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], {
        cwd: shell,
        env: cleanEnv(home),
        timeout: STAGES.install,
      }),
      "npm install",
    );
    if (!existsSync(join(shell, "package-lock.json"))) {
      throw new StepFailure("install", "npm install wrote no package-lock.json");
    }

    // 5. what CI runs, with the branch the workflow passes
    say(`check: CI=true docusystem check --ci (${o.runtime})`);
    const bin = join(shell, "node_modules", ".bin", "docusystem");
    const launch = o.runtime === "bun" ? ["bun", ["--bun", bin]] : [process.execPath, [bin]];
    const env = cleanEnv(home, { CI: "true", DOCUSYSTEM_BRANCH: defaultBranch });
    const check = run(launch[0], [...launch[1], "check", "--ci"], {
      cwd: shell,
      env,
      timeout: STAGES.check,
    });
    result.stage = "check";
    const numbers = readCheckOutput(check.output);
    result.check = numbers;
    if (check.code !== 0 || !numbers.passed) {
      throw new StepFailure(
        "check",
        `docusystem check exited with ${check.code}:\n${tail(check.output, 20)}`,
      );
    }
    const doctor = run(launch[0], [...launch[1], "doctor"], {
      cwd: shell,
      env,
      timeout: STAGES.check,
    });
    result.doctor = {
      code: doctor.code,
      warnings: (doctor.output.match(/^warning /gm) ?? []).length,
    };
    if (doctor.code !== 0) {
      throw new StepFailure(
        "check",
        `docusystem doctor exited with ${doctor.code}:\n${tail(doctor.output, 20)}`,
      );
    }

    // 6. the two sites, side by side
    say("compare: the starter's dist against the shell's");
    result.stage = "compare";
    const thinDist = join(shell, "dist");
    const comparison = compareDist(origDist, thinDist, {
      allow: ALLOWED_DIFFERENCES,
      runtimeA: "bun",
      runtimeB: o.runtime,
      vendored: "auto",
    });
    const searchA = searchDocuments(origDist);
    const searchB = searchDocuments(thinDist);
    result.compare = {
      files: [comparison.filesA, comparison.filesB],
      differences: comparison.differences.map((d) => `${d.path}: ${d.detail}`),
      allowed: comparison.allowed.map((d) => d.path),
      vendoredSkipped: comparison.skipped.length,
      searchDocuments: [searchA, searchB],
    };
    if (!comparison.equal) {
      throw new StepFailure(
        "compare",
        `${comparison.differences.length} file(s) differ:\n  ${result.compare.differences.join("\n  ")}`,
      );
    }
    if (searchA !== searchB || searchA === null) {
      throw new StepFailure(
        "compare",
        `the search index has ${searchA} documents in the starter's build and ${searchB} in the shell's`,
      );
    }
    for (const [label, d] of [
      ["starter", origDist],
      ["shell", thinDist],
    ]) {
      if (existsSync(join(d, "404")) || !existsSync(join(d, "404.html"))) {
        throw new StepFailure("compare", `the ${label}'s build has a /404/ folder or no 404.html`);
      }
    }
    const diffstat =
      git(thin, "add", "-A").code === 0
        ? git(thin, "diff", "--cached", "--shortstat").output.trim()
        : "";
    result.diffstat = diffstat;
    result.stage = "done";
    result.ok = true;
  } catch (error) {
    if (!(error instanceof StepFailure)) throw error;
    result.stage = error.stage;
    result.problems.push(error.message);
  }
  result.seconds = Math.round((Date.now() - started) / 1000);
  return result;
}

// ---- the report ----

/** The summary of the results as lines of text. */
export function renderSummary(results) {
  const lines = ["", "Pilot equivalence rehearsal (section 9.7)", ""];
  for (const r of results) {
    lines.push(`${r.ok ? "PASS" : `FAIL (${r.stage})`}  ${r.name}  (${r.seconds} s)`);
    if (r.ref) lines.push(`    cloned ${r.ref} at ${r.commit}; default branch ${r.defaultBranch}`);
    if (r.migration) {
      lines.push(
        `    migration: ${r.migration.deleted} deleted, ${r.migration.modified} modified, ${r.migration.created} created; ` +
          `${r.migration.kept.length} kept to review; ${r.migration.advice} item(s) of advice`,
      );
    }
    if (r.check) {
      lines.push(
        `    check: ${r.check.pages} pages, ${r.check.references} references crawled, ${r.check.contrastPairs} contrast pairs, ${r.check.routes} routes`,
      );
    }
    if (r.doctor) lines.push(`    doctor: exit ${r.doctor.code}, ${r.doctor.warnings} warning(s)`);
    if (r.compare) {
      lines.push(
        `    compare: ${r.compare.files[0]} files (starter) against ${r.compare.files[1]} (shell), ` +
          `${r.compare.differences.length} differing, ${r.compare.allowed.length} allowed (${r.compare.allowed.join(", ") || "none"}), ` +
          `${r.compare.vendoredSkipped} vendored bundle(s) skipped; search index ${r.compare.searchDocuments[0]} and ${r.compare.searchDocuments[1]} documents`,
      );
    }
    if (r.diffstat) lines.push(`    with the lockfile: ${r.diffstat}`);
    for (const p of r.problems) lines.push(...p.split("\n").map((line) => `    ${line}`));
  }
  const passed = results.filter((r) => r.ok).length;
  lines.push("", `rehearse-pilots: ${passed} of ${results.length} pilot(s) passed`);
  return lines;
}

// ---- the command line ----

const USAGE =
  "usage: node scripts/rehearse-pilots.mjs [--pilot <name>]... [--source <name>=<url|dir>]... [--tarball <file>]\n" +
  "         [--runtime node|bun] [--workflow-sha <sha>] [--work <dir>] [--keep] [--json <file>]";

/** Parses and validates the command line; returns `{ error }` for a usage error. */
export function parseOptions(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: false,
      options: {
        pilot: { type: "string", multiple: true },
        source: { type: "string", multiple: true },
        tarball: { type: "string" },
        runtime: { type: "string" },
        "workflow-sha": { type: "string" },
        work: { type: "string" },
        keep: { type: "boolean" },
        json: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    return { error: error.message };
  }
  const v = parsed.values;
  if (v.help) return { help: true };
  const names = PILOTS.map((p) => p.name);
  for (const name of v.pilot ?? []) {
    if (!names.includes(name))
      return { error: `--pilot must be one of ${names.join(", ")} (got "${name}")` };
  }
  const sources = {};
  for (const entry of v.source ?? []) {
    const at = entry.indexOf("=");
    const name = at < 0 ? "" : entry.slice(0, at);
    const where = at < 0 ? "" : entry.slice(at + 1);
    if (!names.includes(name) || where === "") {
      return {
        error: `--source must be <name>=<url or folder> with a pilot name (got "${entry}")`,
      };
    }
    sources[name] = where;
  }
  const runtime = v.runtime ?? "node";
  if (!["node", "bun"].includes(runtime))
    return { error: `--runtime must be node or bun, not ${runtime}` };
  const sha = (v["workflow-sha"] ?? "0".repeat(40)).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha))
    return { error: `--workflow-sha must be a full 40-character commit id` };
  return {
    pilots: PILOTS.filter((p) => (v.pilot ?? names).includes(p.name)).map((p) =>
      Object.assign({}, p, { url: sources[p.name] ?? p.url }),
    ),
    tarball: v.tarball === undefined ? undefined : resolve(v.tarball),
    runtime,
    sha,
    work: v.work === undefined ? undefined : resolve(v.work),
    keep: v.keep === true,
    json: v.json === undefined ? undefined : resolve(v.json),
  };
}

function main(argv) {
  const options = parseOptions(argv);
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  if (options.error) {
    console.error(`rehearse-pilots: ${options.error}\n${USAGE}`);
    return 2;
  }
  for (const tool of ["git", "bun", "npm"]) {
    const found = spawnSync(tool, ["--version"], { encoding: "utf8" });
    if (found.status !== 0) {
      console.error(
        `rehearse-pilots: ${tool} is not on PATH${tool === "bun" ? " (the baseline is the starter's own build, which runs on Bun)" : ""}`,
      );
      return 2;
    }
  }
  if (options.tarball !== undefined && !existsSync(options.tarball)) {
    console.error(`rehearse-pilots: ${options.tarball} does not exist`);
    return 2;
  }
  if (options.work !== undefined) mkdirSync(options.work, { recursive: true });
  // a real path: the command line prints the paths it works with, and on macOS /var is a link to /private/var
  const work = realpathSync(
    options.work ??
      mkdtempSync(join(process.env.DOCUSYSTEM_TMP ?? tmpdir(), "docusystem-rehearse-")),
  );
  let code = 1;
  try {
    let tarball = options.tarball;
    if (tarball === undefined) {
      const [packed] = JSON.parse(
        execFileSync("npm", ["pack", "--json", "--pack-destination", work], {
          cwd: ROOT,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "inherit"],
        }),
      );
      tarball = join(work, packed.filename);
    }
    const version = JSON.parse(
      execFileSync("tar", ["-xzOf", tarball, "package/package.json"], { encoding: "utf8" }),
    ).version;
    console.log(
      `rehearse-pilots: ${options.pilots.length} pilot(s), ${PACKAGE} ${version} from ${tarball}, shell on ${options.runtime}`,
    );
    const results = options.pilots.map((pilot) =>
      rehearse(pilot, {
        work,
        tarball,
        runtime: options.runtime,
        sha: options.sha,
        log: console.log,
      }),
    );
    for (const line of renderSummary(results)) console.log(line);
    if (options.json) writeFileSync(options.json, `${JSON.stringify(results, null, 2)}\n`);
    code = results.every((r) => r.ok) ? 0 : 1;
  } finally {
    if (options.keep) console.log(`rehearse-pilots: kept ${work}`);
    else if (options.work === undefined) rmSync(work, { recursive: true, force: true });
  }
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
