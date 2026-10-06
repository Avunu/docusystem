import { spawnSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import {
  TYPES,
  breakingNotes,
  findAngleTags,
  problemsWith,
} from "../../scripts/check-pr-title.mjs";
import { REPO_ROOT } from "../support/index.js";

describe("scripts/check-pr-title.mjs", () => {
  test("accepts Conventional Commit titles, scoped, breaking or not", () => {
    for (const title of [
      "feat: add search",
      "fix(nav): order by title",
      "feat(config)!: rename a key",
      "chore(deps-dev): bump x",
      "chore: release v0.1.0",
      "fix(catalog): refresh the bundled project catalog",
      "revert: feat: add search",
    ]) {
      expect(problemsWith(title, ""), title).toEqual([]);
    }
  });

  test("accepts every type of the list, and only those", () => {
    for (const type of TYPES) expect(problemsWith(`${type}: something`, ""), type).toEqual([]);
    expect(problemsWith("wip: something", "")).toHaveLength(1);
    expect(problemsWith("Feat: something", "")).toHaveLength(1);
  });

  test("rejects a title release-please cannot classify", () => {
    for (const title of [
      "Update the thing",
      "feat:missing space",
      "feat: ",
      "feat(Scope): upper",
      "feat(): empty",
      "",
    ]) {
      expect(problemsWith(title, ""), JSON.stringify(title)).toHaveLength(1);
    }
  });

  test("rejects a raw tag in the title or in a BREAKING CHANGE note, but not elsewhere in the body", () => {
    expect(problemsWith("feat: support the <picture> element", "")).toHaveLength(1);
    expect(
      problemsWith("fix: ok", "BREAKING CHANGE: drops <details> support\n\nmore"),
    ).toHaveLength(1);
    expect(problemsWith("fix: ok", "BREAKING-CHANGE: drops <details> support")).toHaveLength(1);
    expect(problemsWith("fix: ok", "Explains a <details> block in the body.\n")).toEqual([]);
    expect(problemsWith("fix: ok", null)).toEqual([]);
  });

  test("finds tags and comment openers, and ignores comparisons and arrows", () => {
    expect(findAngleTags("a <b> c </b> <!-- d")).toEqual(["<b>", "</b>", "<!--"]);
    expect(findAngleTags('<a href="x"> and <my-element>')).toEqual([
      '<a href="x">',
      "<my-element>",
    ]);
    expect(findAngleTags("a < b and c -> d <3")).toEqual([]);
    expect(findAngleTags(undefined)).toEqual([]);
  });

  test("reads a BREAKING CHANGE note up to the next blank line, CRLF included", () => {
    expect(breakingNotes("x\n\nBREAKING CHANGE: one\ncontinues\n\nnot part\n")).toEqual([
      "BREAKING CHANGE: one\ncontinues",
    ]);
    expect(breakingNotes("BREAKING CHANGE: a\r\nmore\r\n\r\nBREAKING-CHANGE: b")).toEqual([
      "BREAKING CHANGE: a\nmore",
      "BREAKING-CHANGE: b",
    ]);
    expect(breakingNotes("no note here")).toEqual([]);
  });

  describe("as a command, the way ci.yml runs it (title and body in the environment)", () => {
    const run = (title: string, body = "") =>
      spawnSync(process.execPath, ["scripts/check-pr-title.mjs"], {
        cwd: REPO_ROOT,
        env: { PATH: process.env.PATH ?? "", PR_TITLE: title, PR_BODY: body },
        encoding: "utf8",
      });

    test("exits 0 for a good title", () => {
      const result = run("feat(config): add a key");
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
    });

    test("exits 1 and prints a workflow annotation for a bad one", () => {
      const result = run("Add a key");
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("::error title=Pull request title::");
    });

    test("exits 1 for a raw tag in a breaking-change note", () => {
      const result = run("feat!: drop it", "BREAKING CHANGE: removes <picture> support");
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("<picture>");
    });

    test("an empty environment is a failure, not a silent pass", () => {
      const result = spawnSync(process.execPath, ["scripts/check-pr-title.mjs"], {
        cwd: REPO_ROOT,
        env: { PATH: process.env.PATH ?? "" },
        encoding: "utf8",
      });
      expect(result.status).toBe(1);
    });
  });
});
