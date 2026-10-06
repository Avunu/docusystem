// replaceDir puts the old tree back when the last step fails. That needs a rename that fails on
// demand, which a real file system will not do, so this file replaces `renameSync` and nothing else.
import { renameSync as realRename } from "node:fs";
import { expect, test, vi } from "vitest";
import { replaceDir } from "../../src/lib/fsutil.js";
import { at, listTree, readTree, tempDir, writeTree } from "../support/index.js";

const fault = vi.hoisted(() => ({
  when: undefined as undefined | ((from: string, to: string) => boolean),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync: (from: string, to: string) => {
      if (fault.when?.(String(from), String(to))) {
        throw Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" });
      }
      return actual.renameSync(from, to);
    },
  };
});

test("the mock passes renames through when nothing is set to fail", () => {
  const dir = tempDir();
  writeTree(dir, { "a.txt": "a" });
  realRename(at(dir, "a.txt"), at(dir, "b.txt"));
  expect(listTree(dir)).toEqual(["b.txt"]);
});

test("if the new tree cannot be moved into place, the old one is back and nothing is left over", () => {
  const dir = tempDir();
  writeTree(dir, { "from/new.txt": "new", "to/old.txt": "old" });
  const target = at(dir, "to");
  fault.when = (from, to) => to === target && from.includes(".tmp-"); // the second rename: fresh -> to
  try {
    expect(() => replaceDir(at(dir, "from"), target)).toThrow(/EXDEV/);
  } finally {
    fault.when = undefined;
  }
  expect(readTree(target)).toEqual({ "old.txt": "old" });
  expect(listTree(dir)).toEqual(["from/", "from/new.txt", "to/", "to/old.txt"]);
});

test("if the old tree cannot be set aside, it is untouched and the copy is removed", () => {
  const dir = tempDir();
  writeTree(dir, { "from/new.txt": "new", "to/old.txt": "old" });
  fault.when = (from) => from === at(dir, "to"); // the first rename: to -> old
  try {
    expect(() => replaceDir(at(dir, "from"), at(dir, "to"))).toThrow(/EXDEV/);
  } finally {
    fault.when = undefined;
  }
  expect(readTree(at(dir, "to"))).toEqual({ "old.txt": "old" });
  expect(listTree(dir)).toEqual(["from/", "from/new.txt", "to/", "to/old.txt"]);
});

test("if the old tree cannot be put back either, the error says where it is, and it is intact", () => {
  const dir = tempDir();
  writeTree(dir, { "from/new.txt": "new", "to/old.txt": "old" });
  const target = at(dir, "to");
  fault.when = (_from, to) => to === target; // both the second rename and the restore
  try {
    expect(() => replaceDir(at(dir, "from"), target)).toThrow(
      /could not move the new .* into place \(EXDEV.*\) and could not put the old one back \(EXDEV.*\); it is at .*to\.old-\d+/,
    );
  } finally {
    fault.when = undefined;
  }
  expect(listTree(dir).filter((path) => /^to\.old-\d+\/old\.txt$/.test(path))).toHaveLength(1);
  expect(listTree(dir).some((path) => path.includes(".tmp-"))).toBe(false);
});
