// scripts/check-github-settings.mjs: the read-only audit of the GitHub settings that the first-release
// runbook asks for (MAINTAINING.md, "GitHub settings"). The settings themselves are not code and cannot
// be tested here. What can be tested is that the audit sees the state that was found on 2026-10-06 (none
// of the hardening in place, which matters most for the publishing path: without the environment `npm`
// limited to `main`, the first publish run creates it unrestricted), that it accepts the state the
// runbook describes and rejects each way of falling short of it, that it never reads "I may not look"
// as "off", and that the names it checks are the ones the workflows really use.
import { spawnSync } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  BRANCH,
  ENVIRONMENT,
  REPOSITORY,
  REQUIRED_CHECK,
  TAG_PATTERN,
  Unreadable,
  auditSettings,
  exitStatus,
  formatReport,
  parseReply,
  type Reader,
  type Reply,
  type SettingResult,
} from "../../scripts/check-github-settings.mjs";
import { REPO_ROOT, tempDir } from "../support/index.js";
import { readJson, readText, workflow } from "./helpers.js";

type Replies = Record<string, Reply>;

const reply = (body: unknown, status = 200): Reply => ({ status, body });
const NOT_FOUND = reply({ message: "Not Found" }, 404);

/** A reader over canned replies; a path with no reply is a 404, like GitHub's answer for a missing thing. */
function reader(replies: Replies, seen: string[] = []): Reader {
  return (path) => {
    seen.push(path);
    return Promise.resolve(replies[path] ?? NOT_FOUND);
  };
}

const audit = async (replies: Replies): Promise<Record<string, SettingResult>> =>
  Object.fromEntries((await auditSettings(reader(replies))).map((r) => [r.id, r]));

const states = (results: Record<string, SettingResult>): Record<string, string> =>
  Object.fromEntries(Object.entries(results).map(([id, r]) => [id, r.state]));

/** The state of Avunu/docusystem read with `gh api` on 2026-10-06 (the evidence of the finding). */
const TODAY: Replies = {
  "": reply({
    default_branch: "main",
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
    allow_squash_merge: true,
    allow_merge_commit: false,
    allow_rebase_merge: true,
    allow_auto_merge: true,
    delete_branch_on_merge: true,
    squash_merge_commit_title: "COMMIT_OR_PR_TITLE",
    squash_merge_commit_message: "COMMIT_MESSAGES",
    security_and_analysis: {
      dependabot_security_updates: { status: "disabled" },
      secret_scanning: { status: "disabled" },
      secret_scanning_push_protection: { status: "disabled" },
    },
  }),
  "environments/npm": NOT_FOUND,
  "rulesets?per_page=100": reply([]),
  "vulnerability-alerts": reply(null, 204),
  "private-vulnerability-reporting": reply({ enabled: false }),
  "immutable-releases": reply({ enabled: false, enforced_by_owner: false }),
  "actions/permissions": reply({
    enabled: true,
    allowed_actions: "all",
    sha_pinning_required: false,
  }),
  "actions/permissions/workflow": reply({
    default_workflow_permissions: "read",
    can_approve_pull_request_reviews: true,
  }),
};

interface Rule {
  type: string;
  parameters?: unknown;
}
const branchRules = (checks: string[] = [REQUIRED_CHECK]): Rule[] => [
  { type: "deletion" },
  { type: "non_fast_forward" },
  { type: "pull_request", parameters: { required_approving_review_count: 0 } },
  {
    type: "required_status_checks",
    parameters: {
      strict_required_status_checks_policy: false,
      required_status_checks: checks.map((context) => ({ context })),
    },
  },
];
const tagRules: Rule[] = [{ type: "update" }, { type: "deletion" }];

interface RulesetSpec {
  id: number;
  target: "branch" | "tag";
  include: string[];
  exclude?: string[];
  rules: Rule[];
  enforcement?: string;
  bypass?: unknown[];
}

/** Adds rulesets the way GitHub answers: a list without rules, and each ruleset in full. */
function withRulesets(base: Replies, ...specs: RulesetSpec[]): Replies {
  const out: Replies = { ...base };
  out["rulesets?per_page=100"] = reply(
    specs.map((s) => ({
      id: s.id,
      name: `r${s.id}`,
      target: s.target,
      enforcement: s.enforcement ?? "active",
    })),
  );
  for (const s of specs) {
    out[`rulesets/${s.id}`] = reply({
      id: s.id,
      target: s.target,
      enforcement: s.enforcement ?? "active",
      conditions: { ref_name: { include: s.include, exclude: s.exclude ?? [] } },
      rules: s.rules,
      bypass_actors: s.bypass ?? [],
    });
  }
  return out;
}

const branchRuleset = (o: Partial<RulesetSpec> = {}): RulesetSpec => ({
  id: 1,
  target: "branch",
  include: ["~DEFAULT_BRANCH"],
  rules: branchRules(),
  ...o,
});
const tagRuleset = (o: Partial<RulesetSpec> = {}): RulesetSpec => ({
  id: 2,
  target: "tag",
  include: [TAG_PATTERN],
  rules: tagRules,
  ...o,
});

function patchRepository(base: Replies, patch: Record<string, unknown>): Replies {
  const repository = base[""]?.body as Record<string, unknown>;
  return { ...base, "": reply({ ...repository, ...patch }) };
}

/** Every setting of the runbook in place. */
const IN_PLACE: Replies = withRulesets(
  {
    ...patchRepository(TODAY, {
      allow_rebase_merge: false,
      squash_merge_commit_title: "PR_TITLE",
      squash_merge_commit_message: "PR_BODY",
      security_and_analysis: {
        dependabot_security_updates: { status: "enabled" },
        secret_scanning: { status: "enabled" },
        secret_scanning_push_protection: { status: "enabled" },
      },
    }),
    "environments/npm": reply({
      name: "npm",
      deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
    }),
    "environments/npm/deployment-branch-policies": reply({
      total_count: 1,
      branch_policies: [{ id: 1, name: "main", type: "branch" }],
    }),
    "private-vulnerability-reporting": reply({ enabled: true }),
    "immutable-releases": reply({ enabled: true, enforced_by_owner: false }),
    "actions/permissions": reply({
      enabled: true,
      allowed_actions: "all",
      sha_pinning_required: true,
    }),
  },
  branchRuleset(),
  tagRuleset(),
);

const IDS = [
  "merge-methods",
  "dependabot-alerts",
  "dependabot-security-updates",
  "secret-scanning",
  "push-protection",
  "private-vulnerability-reporting",
  "branch-ruleset",
  "tag-ruleset",
  "release-immutability",
  "environment",
  "sha-pinning",
  "workflow-token",
];

describe("the state found on 2026-10-06", () => {
  test("none of the hardening is in place: ten of twelve settings are missing", async () => {
    const results = await audit(TODAY);
    expect(Object.keys(results)).toEqual(IDS);
    expect(states(results)).toEqual({
      "merge-methods": "missing",
      "dependabot-alerts": "ok",
      "dependabot-security-updates": "missing",
      "secret-scanning": "missing",
      "push-protection": "missing",
      "private-vulnerability-reporting": "missing",
      "branch-ruleset": "missing",
      "tag-ruleset": "missing",
      "release-immutability": "missing",
      environment: "missing",
      "sha-pinning": "missing",
      "workflow-token": "ok",
    });
    expect(exitStatus(Object.values(results))).toBe(1);
  });

  test("it says what the missing environment costs, and which merge method is on", async () => {
    const results = await audit(TODAY);
    expect(results.environment?.detail).toContain("creates it with no protection rule");
    expect(results["merge-methods"]?.detail).toContain("rebase merging is on");
    expect(results["merge-methods"]?.detail).toContain("COMMIT_OR_PR_TITLE");
    expect(results["branch-ruleset"]?.detail).toBe("no active branch ruleset covers main");
  });
});

describe("the state the runbook describes", () => {
  test("every setting is in place and the exit status is 0", async () => {
    const results = await audit(IN_PLACE);
    expect(Object.values(results).filter((r) => r.state !== "ok")).toEqual([]);
    expect(exitStatus(Object.values(results))).toBe(0);
  });

  test("the repository is read once, however many settings come from it", async () => {
    const seen: string[] = [];
    await auditSettings(reader(IN_PLACE, seen));
    expect(seen.filter((path) => path === "")).toHaveLength(1);
  });
});

describe("merge methods", () => {
  test.each([
    ["rebase merging on", { allow_rebase_merge: true }, "rebase merging is on"],
    ["merge commits on", { allow_merge_commit: true }, "merge commits are on"],
    ["squash merging off", { allow_squash_merge: false }, "squash merging is off"],
    ["the default squash title", { squash_merge_commit_title: "COMMIT_OR_PR_TITLE" }, "PR_TITLE"],
    ["the default squash message", { squash_merge_commit_message: "COMMIT_MESSAGES" }, "PR_BODY"],
    ["head branches kept", { delete_branch_on_merge: false }, "head branches are kept"],
  ])("%s is reported", async (_name, patch, text) => {
    const results = await audit(patchRepository(IN_PLACE, patch));
    expect(results["merge-methods"]?.state).toBe("missing");
    expect(results["merge-methods"]?.detail).toContain(text);
  });
});

describe("security features", () => {
  test.each([
    ["dependabot-security-updates", "dependabot_security_updates"],
    ["secret-scanning", "secret_scanning"],
    ["push-protection", "secret_scanning_push_protection"],
  ])("%s is missing when its status is not enabled", async (id, key) => {
    const analysis = {
      dependabot_security_updates: { status: "enabled" },
      secret_scanning: { status: "enabled" },
      secret_scanning_push_protection: { status: "enabled" },
      [key]: { status: "disabled" },
    };
    const results = await audit(patchRepository(IN_PLACE, { security_and_analysis: analysis }));
    expect(states(results)).toEqual({ ...states(await audit(IN_PLACE)), [id]: "missing" });
  });

  test("Dependabot alerts: 404 is off, 204 is on", async () => {
    expect(
      (await audit({ ...IN_PLACE, "vulnerability-alerts": NOT_FOUND }))["dependabot-alerts"]?.state,
    ).toBe("missing");
    expect((await audit(IN_PLACE))["dependabot-alerts"]?.state).toBe("ok");
  });
});

describe("the environment", () => {
  const environment = (policy: unknown, policies?: unknown[]): Replies => ({
    ...IN_PLACE,
    "environments/npm": reply({ name: "npm", deployment_branch_policy: policy }),
    ...(policies === undefined
      ? {}
      : {
          "environments/npm/deployment-branch-policies": reply({
            total_count: policies.length,
            branch_policies: policies,
          }),
        }),
  });
  const custom = { protected_branches: false, custom_branch_policies: true };

  test("one rule, the branch main: in place", async () => {
    const replies = environment(custom, [{ id: 1, name: "main", type: "branch" }]);
    expect((await audit(replies)).environment?.state).toBe("ok");
  });

  test("an environment with no deployment branch rule lets every branch publish", async () => {
    const result = (await audit(environment(null))).environment;
    expect(result?.state).toBe("missing");
    expect(result?.detail).toContain("any branch");
  });

  test("Protected branches only is reported, because the runbook advises against it", async () => {
    const result = (
      await audit(environment({ protected_branches: true, custom_branch_policies: false }))
    ).environment;
    expect(result?.state).toBe("missing");
    expect(result?.detail).toContain("Protected branches only");
  });

  test.each([
    ["no rule", [], "none"],
    [
      "another branch as well",
      [
        { name: "main", type: "branch" },
        { name: "dev", type: "branch" },
      ],
      "main, dev",
    ],
    ["a different branch", [{ name: "release", type: "branch" }], "release"],
    ["a tag called main", [{ name: "main", type: "tag" }], "tag main"],
  ])("%s is reported", async (_name, policies, text) => {
    const result = (await audit(environment(custom, policies))).environment;
    expect(result?.state).toBe("missing");
    expect(result?.detail).toContain(text);
  });
});

describe("the branch ruleset", () => {
  const branch = async (...specs: RulesetSpec[]) =>
    (await audit(withRulesets(IN_PLACE, ...specs, tagRuleset())))["branch-ruleset"];

  test("the default branch and the name of the branch both count, and so does a pattern", async () => {
    for (const include of [
      ["~DEFAULT_BRANCH"],
      ["refs/heads/main"],
      ["~ALL"],
      ["refs/heads/ma*"],
    ]) {
      expect((await branch(branchRuleset({ include })))?.state, include.join()).toBe("ok");
    }
  });

  test("a ruleset that is not active, or is for tags, or for another branch, does not count", async () => {
    for (const spec of [
      branchRuleset({ enforcement: "evaluate" }),
      branchRuleset({ enforcement: "disabled" }),
      branchRuleset({ include: ["refs/heads/develop"] }),
      branchRuleset({ include: ["~ALL"], exclude: ["refs/heads/main"] }),
      branchRuleset({ target: "tag", include: ["~ALL"] }),
    ]) {
      expect((await branch(spec))?.state, JSON.stringify(spec)).toBe("missing");
    }
  });

  test.each([
    ["no pull request", ["pull_request"], "requires no pull request"],
    ["force pushes", ["non_fast_forward"], "allows force pushes"],
    ["deleting the branch", ["deletion"], "allows deleting the branch"],
    ["the check ci", ["required_status_checks"], "does not require the check ci"],
  ])("without %s", async (_name, drop, text) => {
    const rules = branchRules().filter((rule) => !drop.includes(rule.type));
    const result = await branch(branchRuleset({ rules }));
    expect(result?.state).toBe("missing");
    expect(result?.detail).toContain(text);
  });

  test("a second required check is reported: the ruleset requires ci and no other", async () => {
    const result = await branch(
      branchRuleset({ rules: branchRules(["ci", "Pull request title"]) }),
    );
    expect(result?.state).toBe("missing");
    expect(result?.detail).toBe("also requires Pull request title");
  });

  test("rulesets add up, as they do on GitHub", async () => {
    const result = await branch(
      branchRuleset({ id: 1, rules: [{ type: "deletion" }, { type: "non_fast_forward" }] }),
      branchRuleset({
        id: 3,
        rules: branchRules().filter((r) =>
          ["pull_request", "required_status_checks"].includes(r.type),
        ),
      }),
    );
    expect(result?.state).toBe("ok");
  });
});

describe("the tag ruleset", () => {
  const tag = async (...specs: RulesetSpec[]) =>
    (await audit(withRulesets(IN_PLACE, branchRuleset(), ...specs)))["tag-ruleset"];

  test("the tags of a release, by their pattern or by a wider one", async () => {
    for (const include of [[TAG_PATTERN], ["refs/tags/v*"], ["~ALL"], ["refs/tags/**"]]) {
      expect((await tag(tagRuleset({ include })))?.state, include.join()).toBe("ok");
    }
  });

  test("a pattern that does not cover a release tag, a branch ruleset and an inactive ruleset do not count", async () => {
    for (const spec of [
      tagRuleset({ include: ["refs/tags/release-*"] }),
      tagRuleset({ target: "branch" }),
      tagRuleset({ enforcement: "evaluate" }),
    ]) {
      expect((await tag(spec))?.state, JSON.stringify(spec)).toBe("missing");
    }
  });

  test.each([
    ["updates", "update", "can be moved"],
    ["deletions", "deletion", "can be deleted"],
  ])("a tag ruleset that does not restrict %s", async (_name, type, text) => {
    const result = await tag(tagRuleset({ rules: tagRules.filter((rule) => rule.type !== type) }));
    expect(result?.state).toBe("missing");
    expect(result?.detail).toContain(text);
  });

  test("restricting creation stops release-please, which tags with GITHUB_TOKEN, unless someone may bypass", async () => {
    const rules = [...tagRules, { type: "creation" }];
    const blocked = await tag(tagRuleset({ rules }));
    expect(blocked?.state).toBe("missing");
    expect(blocked?.detail).toContain("release-please could not create the tag");
    const allowed = await tag(
      tagRuleset({ rules, bypass: [{ actor_type: "RepositoryRole", actor_id: 5 }] }),
    );
    expect(allowed?.state).toBe("ok");
  });
});

describe("the other settings", () => {
  test("release immutability and the pinned-actions requirement are read from their endpoints", async () => {
    const off = await audit({
      ...IN_PLACE,
      "immutable-releases": reply({ enabled: false }),
      "actions/permissions": reply({ enabled: true, sha_pinning_required: false }),
    });
    expect(off["release-immutability"]?.state).toBe("missing");
    expect(off["sha-pinning"]?.state).toBe("missing");
  });

  test("a read-write default token, and Actions that may not open pull requests, are reported", async () => {
    const results = await audit({
      ...IN_PLACE,
      "actions/permissions/workflow": reply({
        default_workflow_permissions: "write",
        can_approve_pull_request_reviews: false,
      }),
    });
    expect(results["workflow-token"]?.state).toBe("missing");
    expect(results["workflow-token"]?.detail).toContain("not read");
    expect(results["workflow-token"]?.detail).toContain("cannot open the release pull request");
  });

  test("private vulnerability reporting", async () => {
    const results = await audit({
      ...IN_PLACE,
      "private-vulnerability-reporting": reply({ enabled: false }),
    });
    expect(results["private-vulnerability-reporting"]?.state).toBe("missing");
  });
});

describe("what cannot be read is never reported as off", () => {
  test("an account that does not administer the repository gets unknown for what only admins see", async () => {
    const results = await audit(
      patchRepository(IN_PLACE, { permissions: { admin: false, push: true, pull: true } }),
    );
    expect(states(results)).toEqual({
      "merge-methods": "unknown",
      "dependabot-alerts": "unknown",
      "dependabot-security-updates": "unknown",
      "secret-scanning": "unknown",
      "push-protection": "unknown",
      "private-vulnerability-reporting": "unknown",
      "branch-ruleset": "ok",
      "tag-ruleset": "ok",
      "release-immutability": "unknown",
      environment: "ok",
      "sha-pinning": "unknown",
      "workflow-token": "unknown",
    });
    expect(results["merge-methods"]?.detail).toContain("not logged in as an admin");
    expect(exitStatus(Object.values(results))).toBe(2);
  });

  test("a 403 from an endpoint is unknown, and says why", async () => {
    const results = await audit({
      ...IN_PLACE,
      "actions/permissions": reply({ message: "Forbidden" }, 403),
    });
    expect(results["sha-pinning"]?.state).toBe("unknown");
    expect(results["sha-pinning"]?.detail).toContain("HTTP 403");
  });

  test("a reply without security_and_analysis is unknown", async () => {
    const results = await audit(patchRepository(IN_PLACE, { security_and_analysis: undefined }));
    expect(results["secret-scanning"]?.state).toBe("unknown");
  });

  test("a reader that cannot ask (no gh) makes every setting unknown", async () => {
    const results = await auditSettings(() =>
      Promise.reject(new Unreadable("the `gh` command line is not installed")),
    );
    expect(results.map((r) => r.state)).toEqual(IDS.map(() => "unknown"));
    expect(exitStatus(results)).toBe(2);
  });

  test("a missing setting outranks an unreadable one in the exit status", () => {
    const result = (state: SettingResult["state"]): SettingResult => ({
      id: "x",
      title: "x",
      state,
      detail: "",
      fix: "",
    });
    expect(exitStatus([result("ok"), result("unknown"), result("missing")])).toBe(1);
    expect(exitStatus([result("ok"), result("unknown")])).toBe(2);
    expect(exitStatus([result("ok")])).toBe(0);
  });

  test("an error that is not Unreadable is a bug and is not swallowed", async () => {
    await expect(auditSettings(() => Promise.reject(new TypeError("boom")))).rejects.toThrow(
      "boom",
    );
  });
});

describe("the reply of `gh api --include`", () => {
  test("a status, headers and a JSON body (CRLF line endings, as GitHub sends them)", () => {
    expect(parseReply('HTTP/2.0 200 OK\r\nEtag: "x"\r\n\r\n{\n  "enabled": true\n}\n')).toEqual({
      status: 200,
      body: { enabled: true },
    });
  });

  test("no body: 204", () => {
    expect(parseReply("HTTP/2.0 204 No Content\r\nDate: now\r\n\r\n")).toEqual({
      status: 204,
      body: null,
    });
    expect(parseReply("HTTP/2.0 204 No Content")).toEqual({ status: 204, body: null });
  });

  test("an error status is a reply, not an exception", () => {
    expect(parseReply('HTTP/2.0 404 Not Found\n\n{"message":"Not Found"}')).toEqual({
      status: 404,
      body: { message: "Not Found" },
    });
  });

  test("anything else is Unreadable", () => {
    expect(() => parseReply("")).toThrow(Unreadable);
    expect(() => parseReply("gh: command failed")).toThrow(Unreadable);
    expect(() => parseReply("HTTP/2.0 200 OK\n\n<html>")).toThrow(/not JSON/);
  });
});

describe("the report", () => {
  test("a setting that is in place is one line; one that is not says what it is now and where to fix it", async () => {
    const report = formatReport(REPOSITORY, await auditSettings(reader(TODAY)));
    expect(report.split("\n")[0]).toBe("Avunu/docusystem: 2 of 12 settings are in place");
    expect(report).toContain(
      "  ok       Dependabot alerts\n  MISSING  Dependabot security updates\n",
    );
    expect(report).toContain("now: it does not exist, so the first publish run creates it");
    expect(report).toContain(
      "fix: Settings, Environments (step 6): create npm BEFORE the release pull request is merged",
    );
    const inPlace = formatReport(REPOSITORY, await auditSettings(reader(IN_PLACE)));
    expect(inPlace).not.toContain("now:");
    expect(inPlace.split("\n")).toHaveLength(13);
  });
});

describe("the names the audit checks are the ones the repository uses", () => {
  test("the repository is the one in package.json", () => {
    const pkg = readJson<{ repository: { url: string } }>("package.json");
    expect(pkg.repository.url).toBe(`git+https://github.com/${REPOSITORY}.git`);
  });

  test("the environment is the one the publish job of release.yml runs in, and the runbook's trusted-publisher command names", () => {
    const release = workflow("release.yml");
    expect(release.doc.jobs.publish?.environment).toBe(ENVIRONMENT);
    expect(readText("MAINTAINING.md")).toContain(`--file release.yml --env ${ENVIRONMENT}`);
  });

  test("the branch is the one release.yml runs on and release-please releases from", () => {
    const release = workflow("release.yml");
    expect((release.doc.on.push as { branches: string[] }).branches).toEqual([BRANCH]);
  });

  test("the required check is a job of ci.yml with that very name, which gathers the others", () => {
    const job = workflow("ci.yml").doc.jobs[REQUIRED_CHECK];
    expect(job?.name).toBe(REQUIRED_CHECK);
    expect(job?.needs).toEqual(expect.arrayContaining(["check", "pack"]));
  });

  test("the tag pattern covers the tags release-please creates", () => {
    const config = readJson<Record<string, unknown>>("release-please-config.json");
    expect(config["include-v-in-tag"]).toBe(true);
    expect(config["include-component-in-tag"]).toBe(false);
    expect(TAG_PATTERN).toBe("refs/tags/v*.*.*");
  });
});

// The stand-in is an executable script found through PATH: not on Windows, which is unsupported.
describe.skipIf(process.platform === "win32")("the command line, with a stand-in for gh", () => {
  const script = join(REPO_ROOT, "scripts", "check-github-settings.mjs");

  /** A directory holding a `gh` that answers `gh api --include <url>` from canned replies. */
  function fakeGh(replies: Replies): { path: string } {
    const dir = tempDir();
    const file = join(dir, "replies.json");
    const entries = Object.fromEntries(
      Object.entries(replies).map(([path, r]) => [
        `repos/${REPOSITORY}${path === "" ? "" : `/${path}`}`,
        r,
      ]),
    );
    writeFileSync(file, JSON.stringify(entries));
    const gh = join(dir, "gh");
    writeFileSync(
      gh,
      `#!/usr/bin/env node
const { readFileSync } = require("node:fs");
const replies = JSON.parse(readFileSync(${JSON.stringify(file)}, "utf8"));
const url = process.argv[process.argv.length - 1];
const r = replies[url] ?? { status: 404, body: { message: "Not Found" } };
process.stdout.write("HTTP/2.0 " + r.status + " X\\r\\nContent-Type: application/json\\r\\n\\r\\n");
if (r.body !== null) process.stdout.write(JSON.stringify(r.body));
if (r.status >= 400) { process.stderr.write("gh: error (HTTP " + r.status + ")\\n"); process.exit(1); }
`,
    );
    chmodSync(gh, 0o755);
    return { path: dir };
  }

  const run = (replies: Replies | null, ...args: string[]) => {
    const bin = replies === null ? tempDir() : fakeGh(replies).path;
    const result = spawnSync(process.execPath, [script, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: replies === null ? bin : `${bin}${delimiter}${process.env.PATH}`,
      },
    });
    return { status: result.status, out: result.stdout, err: result.stderr };
  };

  test("every setting in place: exit 0", () => {
    const result = run(IN_PLACE);
    expect(result.out.split("\n")[0]).toBe("Avunu/docusystem: 12 of 12 settings are in place");
    expect(result.status).toBe(0);
  });

  test("the state of 2026-10-06: exit 1 and the environment is named", () => {
    const result = run(TODAY);
    expect(result.out).toContain("MISSING  The environment npm");
    expect(result.status).toBe(1);
  });

  test("--json prints the results", () => {
    const result = run(TODAY, "--json");
    const parsed = JSON.parse(result.out) as SettingResult[];
    expect(parsed.map((r) => r.id)).toEqual(IDS);
    expect(result.status).toBe(1);
  });

  test("no gh on the PATH: every setting is unknown, exit 2", () => {
    const result = run(null);
    expect(result.out).toContain("the `gh` command line is not installed");
    expect(result.status).toBe(2);
  });

  test("a wrong command line: exit 2 and nothing is asked of GitHub", () => {
    expect(run(null, "--repo", "no-slash").err).toContain("--repo must look like owner/name");
    expect(run(null, "--repo", "no-slash").status).toBe(2);
    expect(run(null, "--nope").status).toBe(2);
  });
});
