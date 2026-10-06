#!/usr/bin/env node
// The fleet job (section 9.6 of the architecture record): adopts the docs system in every repository of
// fleet.json from its README, exactly as a maintainer would, and runs the check CI would run. For each
// repository:
//
//   1. a shallow clone, without a token (no credential helper, no prompt),
//   2. `docusystem init --from-readme` from the packed tarball,
//   3. `npm install --ignore-scripts` in docs-site/ (the dependency points at the tarball),
//   4. `CI=true docusystem check`.
//
// The result is a Markdown table with one row per repository (the result and the first ten problem
// lines), printed, appended to $GITHUB_STEP_SUMMARY when that is set, and optionally written as JSON.
// A run is informational: it exits 0 whatever the repositories do. With --enforce every repository must
// pass or be named in fleet.expected-failures.json with a reason, and the exit code is 1 when one that is
// not named fails. Enforcement is on by itself on a release pull request (a branch named release-please--*,
// where the fleet job of ci.yml runs), so that the workflow needs no flag; --informational turns it off.
// An expected failure that now passes is reported, because the entry should go; it never fails the run.
//
//   node scripts/fleet.mjs [options]
//
//   --repo <Avunu/name>   Only this repository (it must be in the fleet file). Repeatable.
//   --tarball <file>      The packed package to adopt with. Default: `npm pack` of this working tree.
//   --fleet <file>        The list of repositories. Default: fleet.json
//   --expected <file>     The reviewed exceptions. Default: fleet.expected-failures.json
//   --enforce             Exit 1 when a repository fails that is not an expected failure. Implied on a
//                         release-please--* branch (GITHUB_HEAD_REF or GITHUB_REF_NAME).
//   --informational       Never exit 1 for a repository, whatever the branch.
//   --concurrency <n>     Repositories adopted at once. Default: 4
//   --clone-base <url>    Where `<owner>/<name>.git` is cloned from. Default: https://github.com
//   --work <dir>          Work in this folder (created if needed). Default: a temporary folder.
//   --keep                Keep the work folder and print where it is.
//   --summary <file>      Also append the Markdown table to this file.
//   --json <file>         Write the results as JSON to this file.
//   --list                Print the repositories of the fleet and exit.
//
// Exit codes: 0 done (see --enforce); 1 a repository failed under --enforce, or the run itself broke;
// 2 usage error or an unreadable fleet file.
import { execFileSync, spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const ROOT = resolve(import.meta.dirname, "..");
const PACKAGE = "@avunu/docusystem";
/** The workflows init writes are pinned to a commit; the fleet never runs them, so a placeholder does. */
const PLACEHOLDER_SHA = "0000000000000000000000000000000000000000";
const STAGES = { clone: 2 * 60_000, init: 2 * 60_000, install: 5 * 60_000, check: 5 * 60_000 };

// ---- the fleet and its exceptions ----

/**
 * Reads and validates the fleet file: an array of `{ repo: "Avunu/<name>", ref?: string, init?: string[] }`.
 * Throws an Error that names the problem.
 */
export function loadFleet(file) {
  let list;
  try {
    list = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`cannot read ${file}: ${error.message}`, { cause: error });
  }
  if (!Array.isArray(list) || list.length === 0)
    throw new Error(`${file} must be a non-empty array`);
  const seen = new Set();
  for (const [at, entry] of list.entries()) {
    const where = `${file}, entry ${at + 1}`;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${where}: not an object`);
    }
    for (const key of Object.keys(entry)) {
      if (!["repo", "ref", "init"].includes(key)) throw new Error(`${where}: unknown key "${key}"`);
    }
    if (typeof entry.repo !== "string" || !/^Avunu\/[A-Za-z0-9._-]+$/.test(entry.repo)) {
      throw new Error(`${where}: "repo" must be Avunu/<name>`);
    }
    if (seen.has(entry.repo)) throw new Error(`${where}: ${entry.repo} is listed twice`);
    seen.add(entry.repo);
    if (
      entry.ref !== undefined &&
      (typeof entry.ref !== "string" || !/^[A-Za-z0-9._/-]+$/.test(entry.ref))
    ) {
      throw new Error(`${where}: "ref" must be a branch or tag name`);
    }
    if (entry.init !== undefined) {
      if (!Array.isArray(entry.init) || entry.init.some((a) => typeof a !== "string")) {
        throw new Error(`${where}: "init" must be an array of strings`);
      }
      const flags = entry.init.filter((a) => a.startsWith("--"));
      for (const flag of flags) {
        if (["--from-readme", "--dry-run", "--site-dir", "--force", "--site"].includes(flag)) {
          throw new Error(`${where}: init option ${flag} is set by the fleet job itself`);
        }
      }
      if (entry.init.length > 0 && !entry.init[0].startsWith("--")) {
        throw new Error(`${where}: "init" must start with an option`);
      }
    }
  }
  return list;
}

/** Reads the reviewed exceptions: `{ "Avunu/<name>": "<reason>" }`, every name in the fleet. */
export function loadExpected(file, fleet) {
  let map;
  try {
    map = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`cannot read ${file}: ${error.message}`, { cause: error });
  }
  if (map === null || typeof map !== "object" || Array.isArray(map)) {
    throw new Error(`${file} must be an object of repository to reason`);
  }
  const names = new Set(fleet.map((entry) => entry.repo));
  for (const [repo, reason] of Object.entries(map)) {
    if (!names.has(repo)) throw new Error(`${file}: ${repo} is not in the fleet`);
    if (typeof reason !== "string" || reason.trim() === "")
      throw new Error(`${file}: ${repo} needs a reason`);
  }
  return map;
}

// ---- running a command ----

/** A hermetic environment for git: no user or system configuration, so no credential helper and no token. */
function gitEnv(home) {
  return {
    PATH: process.env.PATH ?? "",
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    LANG: "C",
  };
}

/** Our environment minus what would change the CLI's behavior, plus `extra`. */
function toolEnv(home, extra = {}) {
  const env = { ...process.env, HOME: home };
  for (const name of [
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

/** Runs a command and resolves with its exit code and everything it printed; never rejects. */
function exec(command, args, o) {
  return new Promise((resolvePromise) => {
    let output = "";
    let child;
    try {
      child = spawn(command, args, { cwd: o.cwd, env: o.env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolvePromise({ code: 127, output: String(error.message) });
      return;
    }
    const timer = setTimeout(() => {
      output += `\n[timed out after ${Math.round(o.timeout / 1000)} s]\n`;
      child.kill("SIGKILL");
    }, o.timeout);
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolvePromise({ code: 127, output: `${output}${error.message}` });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? (signal ? 137 : 1), output });
    });
  });
}

/** What a flaky network prints; a clone or an install that fails with it is tried again. */
const NETWORK_ERROR =
  /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|network (?:aborted|timeout)|Could not resolve host|RPC failed|early EOF|HTTP 5\d\d/i;

/** Runs `attempt()` (resolving with `{ code, output }`) up to `attempts` times while it fails on the network. */
async function retrying(attempt, attempts = 3) {
  const step = await attempt();
  if (step.code === 0 || attempts <= 1 || !NETWORK_ERROR.test(step.output)) return step;
  return retrying(attempt, attempts - 1);
}

// ---- reading a failure ----

const PROBLEM_LINE =
  /\b(?:error|errors|warning|fail|failed|failure|broken|missing|problem|problems|refused|cannot|not found)\b|^docusystem:|^Content\b|::error|ERR!/i;
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");

/**
 * The first `limit` lines of `output` that look like a problem; when none does, the last `limit`
 * non-empty lines (a crash prints no tidy problem line). `strip` paths are shown as `.`.
 */
export function problemLines(output, limit = 10, strip = []) {
  let text = output.replace(ANSI, "");
  for (const path of strip) text = text.split(path).join(".");
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "");
  const problems = lines.filter((line) => PROBLEM_LINE.test(line));
  return (problems.length > 0 ? problems.slice(0, limit) : lines.slice(-limit)).map((line) =>
    line.length > 240 ? `${line.slice(0, 237)}...` : line,
  );
}

// ---- one repository ----

/**
 * A repository whose default branch already carries a copy of the starter (the project-docs starter this
 * system replaces: a docs-site/ whose package.json depends on a @jxsuite package or has a postinstall
 * script, which `init` refuses to adopt) is adopted as if it had none: the starter's docs-site/ and its
 * workflow are removed from the clone first. That is the state of such a repository after its migration,
 * and the Markdown in docs/ is what gets built. Returns the paths removed.
 */
export function removeStarter(repoDir) {
  const manifest = join(repoDir, "docs-site", "package.json");
  if (!existsSync(manifest)) return [];
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(manifest, "utf8"));
  } catch {
    return [];
  }
  const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  if (!names.some((name) => name.startsWith("@jxsuite/")) && !pkg.scripts?.postinstall) return [];
  const removed = ["docs-site"];
  rmSync(join(repoDir, "docs-site"), { recursive: true, force: true });
  const workflow = join(repoDir, ".github", "workflows", "docs.yml");
  if (existsSync(workflow)) {
    rmSync(workflow);
    removed.push(".github/workflows/docs.yml");
  }
  return removed;
}

/**
 * Adopts the docs system in one repository and checks it. Resolves with
 * `{ repo, ok, stage, code, removed, lines, seconds }`: `stage` is where it stopped (`clone`, `init`, `install`,
 * `check`; `done` when it passed).
 */
export async function adopt(entry, o) {
  const started = Date.now();
  const dir = join(o.work, entry.repo.replace("/", "__"));
  const repoDir = join(dir, "repo");
  const home = join(dir, "home");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  let removed = [];
  const result = (ok, stage, code, output) => ({
    repo: entry.repo,
    ok,
    stage,
    code,
    removed,
    lines: ok ? [] : problemLines(output, 10, [repoDir]),
    seconds: Math.round((Date.now() - started) / 1000),
  });

  // 1. a shallow clone without a token; the origin is then what a real clone's would be
  const cloneArgs = [
    "clone",
    "--quiet",
    "--depth",
    "1",
    ...(entry.ref ? ["--branch", entry.ref] : []),
  ];
  let step = await retrying(() => {
    rmSync(repoDir, { recursive: true, force: true });
    return exec("git", [...cloneArgs, `${o.cloneBase}/${entry.repo}.git`, repoDir], {
      cwd: dir,
      env: gitEnv(home),
      timeout: STAGES.clone,
    });
  });
  if (step.code !== 0) return result(false, "clone", step.code, step.output);
  await exec("git", ["remote", "set-url", "origin", `https://github.com/${entry.repo}.git`], {
    cwd: repoDir,
    env: gitEnv(home),
    timeout: 30_000,
  });

  removed = removeStarter(repoDir);

  // 2. init, from the packed package (so that what is adopted is what would be published)
  step = await exec(
    process.execPath,
    [o.bin, "init", "--from-readme", "--workflow-sha", PLACEHOLDER_SHA, ...(entry.init ?? [])],
    { cwd: repoDir, env: toolEnv(home), timeout: STAGES.init },
  );
  if (step.code !== 0) return result(false, "init", step.code, step.output);
  const site = join(repoDir, "docs-site");
  const manifestFile = join(site, "package.json");
  if (!existsSync(manifestFile)) {
    return result(
      false,
      "init",
      1,
      `init exited 0 but wrote no docs-site/package.json\n${step.output}`,
    );
  }
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  manifest.dependencies = { ...manifest.dependencies, [PACKAGE]: `file:${o.tarball}` };
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);

  // 3. install
  step = await retrying(() =>
    exec("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], {
      cwd: site,
      env: toolEnv(home),
      timeout: STAGES.install,
    }),
  );
  if (step.code !== 0) return result(false, "install", step.code, step.output);

  // 4. the check CI runs
  step = await exec(process.execPath, [join(site, "node_modules", ".bin", "docusystem"), "check"], {
    cwd: site,
    env: toolEnv(home, { CI: "true" }),
    timeout: STAGES.check,
  });
  if (step.code !== 0) return result(false, "check", step.code, step.output);
  return result(true, "done", 0, step.output);
}

// ---- the report ----

/** Escapes text for a Markdown table cell. */
const cell = (text) => text.replaceAll("|", "\\|").replaceAll("`", "'").replaceAll("<", "&lt;");

/**
 * Classifies results against the expected failures:
 * `pass`, `fixed` (passes but is listed), `expected` (fails and is listed), `regression` (fails, not listed).
 */
export function classify(results, expected) {
  return results.map((r) => {
    const reason = expected[r.repo];
    const outcome = r.ok
      ? reason === undefined
        ? "pass"
        : "fixed"
      : reason === undefined
        ? "regression"
        : "expected";
    return { ...r, outcome, reason };
  });
}

/** The Markdown summary: one row per repository with its result and first problem lines. */
export function renderSummary(rows, { enforce = false } = {}) {
  const label = {
    pass: "pass",
    fixed: "pass (listed as an expected failure: remove the entry)",
    expected: "expected failure",
    regression: enforce ? "FAIL" : "fail",
  };
  const passed = rows.filter((r) => r.ok).length;
  const out = [
    "### Fleet: docusystem adoption of the Avunu repositories",
    "",
    `${passed} of ${rows.length} repositories pass.`,
    "",
    "| Repository | Result | First problem lines |",
    "| --- | --- | --- |",
  ];
  for (const r of rows) {
    const where = r.ok ? "" : ` (${r.stage})`;
    const starter = r.removed?.length
      ? `; the starter's ${r.removed.join(" and ")} removed first`
      : "";
    const result = `${label[r.outcome]}${where}${r.reason ? `: ${r.reason}` : ""}${starter}`;
    const lines = r.lines.map((line) => `\`${cell(line)}\``).join("<br>");
    out.push(`| ${r.repo} | ${cell(result)} | ${lines} |`);
  }
  return `${out.join("\n")}\n`;
}

// ---- the command line ----

const USAGE =
  "usage: node scripts/fleet.mjs [--repo Avunu/<name>]... [--tarball <file>] [--fleet <file>] [--expected <file>]\n" +
  "         [--enforce | --informational] [--concurrency <n>] [--clone-base <url>] [--work <dir>] [--keep] [--summary <file>]\n" +
  "         [--json <file>] [--list]";

/** Parses the command line; returns `{ error }` for a usage error. */
export function parseOptions(argv, env = process.env) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: false,
      options: {
        repo: { type: "string", multiple: true },
        tarball: { type: "string" },
        fleet: { type: "string" },
        expected: { type: "string" },
        enforce: { type: "boolean" },
        informational: { type: "boolean" },
        concurrency: { type: "string" },
        "clone-base": { type: "string" },
        work: { type: "string" },
        keep: { type: "boolean" },
        summary: { type: "string" },
        json: { type: "string" },
        list: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    return { error: error.message };
  }
  const v = parsed.values;
  if (v.help) return { help: true };
  if (v.enforce && v.informational)
    return { error: "--enforce and --informational exclude each other" };
  const onReleaseBranch = /^release-please--/.test(
    env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME || "",
  );
  const concurrency = v.concurrency === undefined ? 4 : Number(v.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    return { error: "--concurrency must be a whole number from 1 to 32" };
  }
  return {
    repos: v.repo ?? [],
    tarball: v.tarball === undefined ? undefined : resolve(v.tarball),
    fleet: resolve(v.fleet ?? join(ROOT, "fleet.json")),
    expected: resolve(v.expected ?? join(ROOT, "fleet.expected-failures.json")),
    enforce: v.enforce === true || (onReleaseBranch && v.informational !== true),
    concurrency,
    cloneBase: (v["clone-base"] ?? "https://github.com").replace(/\/+$/, ""),
    work: v.work === undefined ? undefined : resolve(v.work),
    keep: v.keep === true,
    summary: v.summary === undefined ? undefined : resolve(v.summary),
    json: v.json === undefined ? undefined : resolve(v.json),
    list: v.list === true,
  };
}

async function main(argv) {
  const options = parseOptions(argv);
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  if (options.error) {
    console.error(`fleet: ${options.error}\n${USAGE}`);
    return 2;
  }
  let fleet;
  let expected;
  try {
    fleet = loadFleet(options.fleet);
    expected = existsSync(options.expected) ? loadExpected(options.expected, fleet) : {};
  } catch (error) {
    console.error(`fleet: ${error.message}`);
    return 2;
  }
  for (const repo of options.repos) {
    if (!fleet.some((entry) => entry.repo === repo)) {
      console.error(`fleet: ${repo} is not in ${options.fleet}`);
      return 2;
    }
  }
  const selected =
    options.repos.length === 0
      ? fleet
      : fleet.filter((entry) => options.repos.includes(entry.repo));
  if (options.list) {
    for (const entry of selected) console.log(entry.repo);
    return 0;
  }

  const work =
    options.work ?? mkdtempSync(join(process.env.DOCUSYSTEM_TMP ?? tmpdir(), "docusystem-fleet-"));
  mkdirSync(work, { recursive: true });
  let code = 0;
  try {
    // the package, packed once: init runs from it and every repository installs it
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
    } else if (!existsSync(tarball)) {
      console.error(`fleet: ${tarball} does not exist`);
      return 2;
    }
    const tool = join(work, "tool");
    mkdirSync(tool, { recursive: true });
    writeFileSync(join(tool, "package.json"), '{ "private": true }\n');
    const installed = await exec(
      "npm",
      ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball],
      {
        cwd: tool,
        env: toolEnv(join(work, "tool-home")),
        timeout: STAGES.install,
      },
    );
    if (installed.code !== 0) {
      console.error(`fleet: cannot install the tarball:\n${installed.output}`);
      return 1;
    }
    const bin = join(tool, "node_modules", ".bin", "docusystem");
    console.log(
      `fleet: ${selected.length} repositor${selected.length === 1 ? "y" : "ies"}, ${options.concurrency} at a time`,
    );

    // a small pool: each worker takes the next repository until none is left
    const results = new Array(selected.length);
    let next = 0;
    const worker = async () => {
      const at = next++;
      if (at >= selected.length) return;
      const entry = selected[at];
      const result = await adopt(entry, { work, bin, tarball, cloneBase: options.cloneBase });
      results[at] = result;
      console.log(
        `fleet: ${result.ok ? "pass" : `FAIL (${result.stage})`}  ${entry.repo}  (${result.seconds} s)`,
      );
      await worker();
    };
    await Promise.all(
      Array.from({ length: Math.min(options.concurrency, selected.length) }, worker),
    );

    const rows = classify(results, expected);
    const summary = renderSummary(rows, { enforce: options.enforce });
    console.log(`\n${summary}`);
    for (const target of [process.env.GITHUB_STEP_SUMMARY, options.summary]) {
      if (target) appendFileSync(target, `${summary}\n`);
    }
    if (options.json) writeFileSync(options.json, `${JSON.stringify(rows, null, 2)}\n`);
    for (const r of rows) {
      if (r.outcome === "fixed")
        console.log(`fleet: ${r.repo} passes now: remove it from the expected failures`);
    }
    const regressions = rows.filter((r) => r.outcome === "regression");
    if (options.enforce && regressions.length > 0) {
      console.error(
        `fleet: ${regressions.length} repositor${regressions.length === 1 ? "y" : "ies"} fail and ${regressions.length === 1 ? "is" : "are"} not expected to: ${regressions.map((r) => r.repo).join(", ")}`,
      );
      code = 1;
    }
  } finally {
    if (options.keep) console.log(`fleet: kept ${work}`);
    else if (options.work === undefined) rmSync(work, { recursive: true, force: true });
  }
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
