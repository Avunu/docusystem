#!/usr/bin/env node
// Reads the GitHub settings of this repository that the first-release runbook asks for (MAINTAINING.md,
// "GitHub settings") and says which of them are not in place. It only reads: every request is a GET
// made through the `gh` command line, and nothing is changed. A pull request cannot make these settings
// (they are not files), so this is how a person, or an agent, checks them before merging the release
// pull request and again afterwards.
//
//   node scripts/check-github-settings.mjs [--repo owner/name] [--json]
//
// Needs `gh`, logged in as someone with admin access to the repository: GitHub shows the merge settings,
// the security features and the Actions settings only to them, and a setting the account may not see is
// reported as unknown, never as off. Exit status: 0 every setting is in place, 1 at least one is not,
// 2 none is missing but one could not be read (or the command line is wrong).
//
// Why these and why they matter most for the publishing path: the trusted publisher on npmjs.com checks
// the repository, the workflow file and the environment name, but not the branch. Without the
// environment `npm` limited to `main`, the first publish run creates the environment with no
// restriction at all, and a copy of release.yml edited and dispatched from any other branch could then
// obtain a publish token.
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";

const run = promisify(execFile);

/** The repository whose settings are read when `--repo` is not given. */
export const REPOSITORY = "Avunu/docusystem";
/** The environment of the `publish` job in release.yml and of the trusted publisher on npmjs.com. */
export const ENVIRONMENT = "npm";
/** The one branch that environment, and the branch ruleset, are about. */
export const BRANCH = "main";
/** The one status check the branch ruleset requires: the job `ci` of ci.yml, which gathers the rest. */
export const REQUIRED_CHECK = "ci";
/** The tags release-please creates (`include-v-in-tag`), as a ruleset pattern. */
export const TAG_PATTERN = "refs/tags/v*.*.*";
/** A tag of that shape, to test whether a ruleset's pattern covers the tags of a release. */
const SAMPLE_TAG = "refs/tags/v0.1.0";

/** A setting that could not be read: no `gh`, not logged in, no admin access, an unexpected reply. */
export class Unreadable extends Error {}

/**
 * Splits the output of `gh api --include`: a status line, headers, a blank line, then the body.
 * @param {string} output
 * @returns {{ status: number; body: any }}
 */
export function parseReply(output) {
  const split = output.search(/\r?\n\r?\n/);
  const head = split === -1 ? output : output.slice(0, split);
  const text = split === -1 ? "" : output.slice(split).trim();
  const status = Number(/^HTTP\/\S+ (\d{3})/.exec(head)?.[1]);
  if (!Number.isInteger(status)) throw new Unreadable("gh printed no HTTP status line");
  let body = null;
  if (text !== "") {
    try {
      body = JSON.parse(text);
    } catch {
      throw new Unreadable(`HTTP ${status} with a body that is not JSON`);
    }
  }
  return { status, body };
}

/**
 * A reader of `repos/<repository>/<path>` through `gh`. An error status is a reply like any other (a
 * missing environment is a 404 and the answer to the question); only a failure to ask is thrown.
 * @param {string} repository
 */
export function ghReader(repository) {
  return async (path) => {
    const url = `repos/${repository}${path === "" ? "" : `/${path}`}`;
    try {
      const { stdout } = await run("gh", ["api", "--include", url], {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      });
      return parseReply(stdout);
    } catch (error) {
      if (error instanceof Unreadable) throw error;
      if (error?.code === "ENOENT") throw new Unreadable("the `gh` command line is not installed");
      // `gh` exits 1 on an HTTP error status but still prints the response before it does.
      if (typeof error?.stdout === "string" && /^HTTP\/\S+ \d{3}/.test(error.stdout)) {
        return parseReply(error.stdout);
      }
      const why = String(error?.stderr ?? error?.message ?? error).trim();
      throw new Unreadable(`gh api ${url}: ${why.split("\n")[0]}`);
    }
  };
}

/**
 * Reads a path, and refuses any status that is not one of the expected ones.
 * @param {(path: string) => Promise<{status: number; body: any}>} get
 */
async function need(get, path, accepted = [200]) {
  const reply = await get(path);
  if (!accepted.includes(reply.status)) {
    const hint =
      reply.status === 403 || reply.status === 404
        ? " (admin access is needed, or GitHub does not offer it here)"
        : "";
    throw new Unreadable(
      `GET ${path === "" ? "the repository" : path}: HTTP ${reply.status}${hint}`,
    );
  }
  return reply;
}

/**
 * The repository, if the account `gh` is logged in as administers it. GitHub shows the merge settings,
 * the security features and the Actions settings to admins only and answers everyone else with a missing
 * field or a 404, which must not be read as "off".
 */
async function admin(get) {
  const repo = (await need(get, "")).body;
  if (repo.permissions?.admin !== true) {
    throw new Unreadable(
      "gh is not logged in as an admin of the repository, and GitHub shows this setting only to admins",
    );
  }
  return repo;
}

/** `need` for a path that only an admin can read. */
async function adminNeed(get, path, accepted) {
  await admin(get);
  return need(get, path, accepted);
}

/** `*` does not cross a `/`, `**` does: the pattern syntax of a ruleset's ref names. */
function globToRegExp(pattern) {
  const source = pattern
    .split("**")
    .map((part) => part.split("*").map(escapeRegExp).join("[^/]*"))
    .join(".*");
  return new RegExp(`^${source}$`);
}
const escapeRegExp = (text) => text.replace(/[\\^$.|?+()[\]{}]/g, "\\$&");

/** Whether a ruleset's `ref_name` condition covers this ref (`~DEFAULT_BRANCH` and `~ALL` included). */
function covers(ruleset, ref, defaultBranch) {
  const { include = [], exclude = [] } = ruleset.conditions?.ref_name ?? {};
  const hit = (patterns) =>
    patterns.some(
      (pattern) =>
        pattern === "~ALL" ||
        (pattern === "~DEFAULT_BRANCH" && ref === `refs/heads/${defaultBranch}`) ||
        globToRegExp(pattern).test(ref),
    );
  return hit(include) && !hit(exclude);
}

/** The active rulesets of a target (`branch` or `tag`) that cover the ref, in full (the list has no rules). */
async function rulesetsFor(get, target, ref) {
  const [{ body: list }, { body: repository }] = await Promise.all([
    need(get, "rulesets?per_page=100"),
    need(get, ""),
  ]);
  const active = list.filter((s) => s.target === target && s.enforcement === "active");
  const full = await Promise.all(active.map((s) => need(get, `rulesets/${s.id}`)));
  return full.map((reply) => reply.body).filter((r) => covers(r, ref, repository.default_branch));
}

const typesOf = (rulesets) => new Set(rulesets.flatMap((r) => r.rules.map((rule) => rule.type)));

/**
 * One entry per setting of the runbook. `run` returns the problems it found (an empty list: in place) or
 * throws `Unreadable`; `fix` says where to make the setting, in the words of MAINTAINING.md.
 */
const CHECKS = [
  {
    id: "merge-methods",
    title: "Squash merging only, with the pull request title and description as the message",
    fix: "Settings, General, Pull Requests (MAINTAINING.md, GitHub settings, step 1): turn off rebase and merge commits, set the squash message to 'Pull request title and description', delete head branches on merge.",
    run: async (get) => {
      const repo = await admin(get);
      const problems = [];
      if (repo.allow_squash_merge !== true) problems.push("squash merging is off");
      if (repo.allow_rebase_merge !== false) problems.push("rebase merging is on");
      if (repo.allow_merge_commit !== false) problems.push("merge commits are on");
      if (
        repo.squash_merge_commit_title !== "PR_TITLE" ||
        repo.squash_merge_commit_message !== "PR_BODY"
      ) {
        problems.push(
          `the squash message is ${repo.squash_merge_commit_title} and ${repo.squash_merge_commit_message}, not PR_TITLE and PR_BODY`,
        );
      }
      if (repo.delete_branch_on_merge !== true)
        problems.push("head branches are kept after a merge");
      return problems;
    },
  },
  {
    id: "dependabot-alerts",
    title: "Dependabot alerts",
    fix: "Settings, Code security (step 2): enable Dependabot alerts.",
    run: async (get) =>
      (await adminNeed(get, "vulnerability-alerts", [204, 404])).status === 204
        ? []
        : ["they are off"],
  },
  ...[
    ["dependabot-security-updates", "Dependabot security updates", "dependabot_security_updates"],
    ["secret-scanning", "Secret scanning", "secret_scanning"],
    ["push-protection", "Secret scanning push protection", "secret_scanning_push_protection"],
  ].map(([id, title, key]) => ({
    id,
    title,
    fix: "Settings, Code security (step 2): enable it.",
    run: async (get) => {
      const analysis = (await admin(get)).security_and_analysis;
      if (analysis === undefined || analysis === null) {
        throw new Unreadable("the reply has no security_and_analysis (admin access is needed)");
      }
      const status = analysis[key]?.status;
      return status === "enabled" ? [] : [`it is ${status ?? "not reported"}`];
    },
  })),
  {
    id: "private-vulnerability-reporting",
    title: "Private vulnerability reporting",
    fix: "Settings, Code security (step 2): enable private vulnerability reporting (SECURITY.md points at it).",
    run: async (get) =>
      (await adminNeed(get, "private-vulnerability-reporting")).body.enabled === true
        ? []
        : ["it is off"],
  },
  {
    id: "branch-ruleset",
    title: `A ruleset on ${BRANCH}: pull request, the check ${REQUIRED_CHECK} and no other, no force push, no deletion`,
    fix: `Settings, Rules, Rulesets (step 3): a branch ruleset for ${BRANCH}, active.`,
    run: async (get) => {
      const rulesets = await rulesetsFor(get, "branch", `refs/heads/${BRANCH}`);
      if (rulesets.length === 0) return [`no active branch ruleset covers ${BRANCH}`];
      const problems = [];
      const types = typesOf(rulesets);
      for (const [type, what] of [
        ["pull_request", "requires no pull request"],
        ["non_fast_forward", "allows force pushes"],
        ["deletion", "allows deleting the branch"],
      ]) {
        if (!types.has(type)) problems.push(what);
      }
      const checks = rulesets
        .flatMap((r) => r.rules)
        .filter((rule) => rule.type === "required_status_checks")
        .flatMap((rule) => rule.parameters.required_status_checks.map((c) => c.context));
      if (!checks.includes(REQUIRED_CHECK))
        problems.push(`does not require the check ${REQUIRED_CHECK}`);
      const others = [...new Set(checks)].filter((context) => context !== REQUIRED_CHECK);
      if (others.length > 0) problems.push(`also requires ${others.join(", ")}`);
      return problems;
    },
  },
  {
    id: "tag-ruleset",
    title: `A ruleset on the tags ${TAG_PATTERN.slice("refs/tags/".length)}: no updates, no deletions`,
    fix: "Settings, Rules, Rulesets (step 4): a tag ruleset, active, restricting updates and deletions only.",
    run: async (get) => {
      const rulesets = await rulesetsFor(get, "tag", SAMPLE_TAG);
      if (rulesets.length === 0)
        return [`no active tag ruleset covers a tag such as ${SAMPLE_TAG}`];
      const problems = [];
      const types = typesOf(rulesets);
      if (!types.has("update")) problems.push("a released tag can be moved");
      if (!types.has("deletion")) problems.push("a released tag can be deleted");
      // release-please creates the tag with GITHUB_TOKEN; restricting creation stops every release.
      if (
        rulesets.some((r) => typesOf([r]).has("creation") && (r.bypass_actors ?? []).length === 0)
      ) {
        problems.push(
          "it restricts creation with no bypass actor, so release-please could not create the tag",
        );
      }
      return problems;
    },
  },
  {
    id: "release-immutability",
    title: "Release immutability",
    fix: "Settings, General, Releases (step 5): turn on release immutability.",
    run: async (get) =>
      (await adminNeed(get, "immutable-releases")).body.enabled === true ? [] : ["it is off"],
  },
  {
    id: "environment",
    title: `The environment ${ENVIRONMENT}, limited to the branch ${BRANCH} by a selected-branch rule`,
    fix: `Settings, Environments (step 6): create ${ENVIRONMENT} BEFORE the release pull request is merged, with Selected branches and tags and the one pattern ${BRANCH}.`,
    run: async (get) => {
      const path = `environments/${ENVIRONMENT}`;
      const reply = await need(get, path, [200, 404]);
      if (reply.status === 404) {
        return [
          `it does not exist, so the first publish run creates it with no protection rule and no branch restriction`,
        ];
      }
      const policy = reply.body.deployment_branch_policy;
      if (policy === null || policy === undefined) {
        return ["it has no deployment branch rule, so a run from any branch can use it"];
      }
      if (policy.protected_branches === true) {
        return [
          "it is limited to Protected branches only; the runbook says to choose Selected branches and tags",
        ];
      }
      const { body } = await need(get, `${path}/deployment-branch-policies`);
      const found = body.branch_policies.map((p) => `${p.type === "tag" ? "tag " : ""}${p.name}`);
      return found.length === 1 && found[0] === BRANCH
        ? []
        : [
            `its deployment rules are ${found.length === 0 ? "none" : found.join(", ")}, not only ${BRANCH}`,
          ];
    },
  },
  {
    id: "sha-pinning",
    title: "Actions must be pinned to a full-length commit SHA",
    fix: "Settings, Actions, General (step 7): require actions to be pinned to a full-length commit SHA.",
    run: async (get) =>
      (await adminNeed(get, "actions/permissions")).body.sha_pinning_required === true
        ? []
        : ["it is off"],
  },
  {
    id: "workflow-token",
    title: "A read-only default workflow token that may still create pull requests",
    fix: "Settings, Actions, General (step 7): default workflow permissions Read; allow Actions to create and approve pull requests (release-please needs it).",
    run: async (get) => {
      const { default_workflow_permissions: token, can_approve_pull_request_reviews: approve } = (
        await adminNeed(get, "actions/permissions/workflow")
      ).body;
      const problems = [];
      if (token !== "read") problems.push(`the default workflow permission is ${token}, not read`);
      if (approve !== true)
        problems.push(
          "Actions may not create pull requests, so release-please cannot open the release pull request",
        );
      return problems;
    },
  },
];

/**
 * Runs every check against the settings that `get` reads and returns one result per setting, in order.
 * `get(path)` resolves `{ status, body }` for `repos/<repository>/<path>` (path "" is the repository).
 * @param {(path: string) => Promise<{status: number; body: any}>} get
 * @returns {Promise<{ id: string; title: string; state: "ok" | "missing" | "unknown"; detail: string; fix: string }[]>}
 */
export async function auditSettings(get) {
  const cache = new Map();
  const cached = (path) => {
    if (!cache.has(path)) cache.set(path, get(path));
    return cache.get(path);
  };
  return Promise.all(
    CHECKS.map(async ({ id, title, fix, run: check }) => {
      try {
        const problems = await check(cached);
        return {
          id,
          title,
          state: problems.length === 0 ? "ok" : "missing",
          detail: problems.join("; "),
          fix,
        };
      } catch (error) {
        if (!(error instanceof Unreadable)) throw error;
        return { id, title, state: "unknown", detail: error.message, fix };
      }
    }),
  );
}

/** The exit status for a set of results: 1 when a setting is missing, else 2 when one is unreadable. */
export function exitStatus(results) {
  if (results.some((r) => r.state === "missing")) return 1;
  return results.some((r) => r.state === "unknown") ? 2 : 0;
}

/** The report, one block per setting that is not in place. */
export function formatReport(repository, results) {
  const inPlace = results.filter((r) => r.state === "ok").length;
  const lines = [`${repository}: ${inPlace} of ${results.length} settings are in place`];
  for (const r of results) {
    const mark = { ok: "ok     ", missing: "MISSING", unknown: "UNKNOWN" }[r.state];
    lines.push(`  ${mark}  ${r.title}`);
    if (r.state !== "ok") {
      lines.push(`           now: ${r.detail}`, `           fix: ${r.fix}`);
    }
  }
  return lines.join("\n");
}

async function main() {
  let args;
  try {
    args = parseArgs({
      options: { repo: { type: "string" }, json: { type: "boolean" }, help: { type: "boolean" } },
      allowPositionals: false,
    }).values;
  } catch (error) {
    console.error(`check-github-settings: ${error.message}`);
    return 2;
  }
  if (args.help) {
    console.log("usage: node scripts/check-github-settings.mjs [--repo owner/name] [--json]");
    return 0;
  }
  const repository = args.repo ?? REPOSITORY;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) {
    console.error(`check-github-settings: --repo must look like owner/name, not ${repository}`);
    return 2;
  }
  const results = await auditSettings(ghReader(repository));
  console.log(args.json ? JSON.stringify(results, null, 2) : formatReport(repository, results));
  return exitStatus(results);
}

// `import.meta.main` exists only on Node 24.2+; this must also run (and not silently pass) on 22.
if (
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exit(await main());
}
