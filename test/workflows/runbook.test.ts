// The first-release runbook (MAINTAINING.md) against the files it describes. The GitHub settings it
// lists are not code and cannot be tested here; what can be tested is that the runbook keeps naming
// the workflow file, the environment and the release pull request lookup that the code really has,
// and that it keeps the instructions that a review of the first release found missing: create the
// environment with a selected-branch rule (GitHub creates it unrestricted otherwise), never use
// "Protected branches only", and merge the release pull request by squash without editing it.
import { describe, expect, test } from "vitest";
import { readJson, readText, workflow } from "./helpers.js";

// A Windows checkout may have CRLF line endings; the sections are found line by line.
const maintaining = readText("MAINTAINING.md").replace(/\r\n/g, "\n");
const release = workflow("release.yml");

/** The text under the heading with this title, up to the next heading of the same or a higher level. */
function section(title: string): string {
  const lines = maintaining.split("\n");
  const start = lines.findIndex(
    (line) => /^#{2,3} /.test(line) && line.replace(/^#+ /, "") === title,
  );
  if (start === -1) throw new Error(`MAINTAINING.md has no section "${title}"`);
  const depth = /^#+/.exec(lines[start] ?? "")?.[0].length ?? 2;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => {
    const hashes = /^(#+) /.exec(line)?.[1];
    return hashes !== undefined && hashes.length <= depth;
  });
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

/** The numbered item that starts with this text, with its nested bullets. */
function item(text: string, start: string): string {
  const lines = text.split("\n");
  const first = lines.findIndex((line) => line.startsWith(start));
  if (first === -1) throw new Error(`no list item starting with ${JSON.stringify(start)}`);
  const rest = lines.slice(first + 1);
  const end = rest.findIndex((line) => !/^\s+\S/.test(line));
  return [lines[first], ...(end === -1 ? rest : rest.slice(0, end))].join("\n");
}

describe("the first-release runbook", () => {
  test("the trusted-publisher command names the workflow file and the environment that release.yml uses", () => {
    const command = /npm trust github \S+ --repo (\S+) --file (\S+) --env (\S+)/.exec(maintaining);
    expect(command, "MAINTAINING.md shows the `npm trust github` command").not.toBeNull();
    const [, repo, file, env] = command ?? [];
    expect(repo).toBe("Avunu/docusystem");
    expect(file).toBe(release.file);
    expect(release.doc.jobs.publish?.environment).toBe(env);
  });

  test("release-please keeps the default labels the runbook says its lookup depends on", () => {
    const config = readJson<Record<string, unknown>>("release-please-config.json");
    for (const key of ["label", "release-label", "snapshot-label", "skip-labeling"]) {
      expect(config[key], `${key} would change the label the runbook names`).toBeUndefined();
    }
    expect(section("Merging the release pull request")).toContain("`autorelease: pending`");
  });
});

describe("GitHub settings of the runbook", () => {
  const settings = section("GitHub settings");

  test("the environment npm is created before the release, limited to main by a selected-branch rule", () => {
    const step = item(settings, "6. **Settings, Environments.**");
    expect(step).toContain("Create `npm` before the release pull request is merged");
    expect(step).toContain("**Selected branches and tags**");
    expect(step).toContain("`main`");
  });

  test("it says that a missing environment is created unrestricted by the first run", () => {
    const step = item(settings, "6. **Settings, Environments.**");
    expect(step).toMatch(/does not exist when the first `publish` job runs, GitHub creates it/);
    expect(step).toContain("no branch restriction");
  });

  test('it warns against "Protected branches only", because main is protected by a ruleset', () => {
    const step = item(settings, "6. **Settings, Environments.**");
    expect(step).toContain("Do not choose **Protected branches only**");
    // The environment option is defined by branch protection rules; step 3 protects main with a ruleset.
    expect(item(settings, "3. **Settings, Rules, Rulesets, branch `main`.**")).toContain(
      "Rulesets",
    );
  });

  test("squash merging is the only merge method the runbook asks for", () => {
    const step = item(settings, "1. **Settings, General, Pull Requests.**");
    expect(step).toContain("Allow squash merging only");
    expect(step).toContain("turn rebase merging off");
  });
});

describe("merging the release pull request", () => {
  const merging = section("Merging the release pull request");

  test("is by squash, with no edit to the title or the description, and never by rebase", () => {
    expect(merging).toContain("**Squash and merge**");
    expect(merging).toContain("do not edit the title or the description");
    expect(merging).toContain("Do not rebase-merge it");
  });

  test("says why: release-please reads the label, branch name, title and body, and an edit means no tag and no publish", () => {
    expect(merging).toContain(
      "its branch name, its title and its body, never by the commit subject",
    );
    expect(merging).toContain("creates no tag and no GitHub Release");
    expect(merging).toContain("the `publish` job is skipped");
  });

  test("the title the runbook says release-please writes is the title the configuration produces", () => {
    const config = readJson<Record<string, string>>("release-please-config.json");
    expect(config["pull-request-title-pattern"]).toBe("chore: release v${version}");
    expect(maintaining).toContain("`chore: release v<VERSION>`");
  });

  test("the first-release steps link to the section", () => {
    expect(maintaining).toContain("(#merging-the-release-pull-request)");
    expect(item(section("First release"), "4. **Merge**")).toContain("squash");
  });
});
