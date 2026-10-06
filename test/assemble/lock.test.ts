import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { acquireLock, LockError } from "../../src/lib/lock.js";
import { tempDir, writeTree } from "../support/index.js";
import { makePaths } from "./helpers.js";

/** The lock paths of a throwaway site folder (the `.docusystem` folder does not exist yet). */
function lockPaths(): { work: string; lock: string } {
  const site = join(tempDir(), "docs-site");
  const { work, lock } = makePaths(site, site, site);
  return { work, lock };
}

const alive =
  (...pids: number[]) =>
  (pid: number) =>
    pids.includes(pid);

describe("acquireLock", () => {
  test("creates .docusystem/lock with the pid and releases it", () => {
    const paths = lockPaths();
    const release = acquireLock(paths, { pid: 1111 });
    expect(readFileSync(paths.lock, "utf8")).toBe("1111\n");
    release();
    expect(existsSync(paths.lock)).toBe(false);
    expect(existsSync(paths.work)).toBe(true);
  });

  test("a live holder is refused, and named in the error", () => {
    const paths = lockPaths();
    const release = acquireLock(paths, { pid: 1111 });
    let error: unknown;
    try {
      acquireLock(paths, { pid: 2222, alive: alive(1111) });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(LockError);
    expect((error as LockError).pid).toBe(1111);
    expect((error as LockError).message).toContain("pid 1111");
    expect((error as LockError).message).toContain(paths.lock);
    // The refused attempt changed nothing.
    expect(readFileSync(paths.lock, "utf8")).toBe("1111\n");
    release();
  });

  test("a holder that is alive in another process is refused: the lock file of a run that is under way", () => {
    const paths = lockPaths();
    writeTree(paths.work, { lock: "4321\n" });
    expect(() => acquireLock(paths, { pid: 2222, alive: alive(4321) })).toThrow(
      expect.objectContaining({ name: "LockError", pid: 4321 }),
    );
  });

  test("a dead holder is replaced", () => {
    const paths = lockPaths();
    writeTree(paths.work, { lock: "1111\n" });
    const release = acquireLock(paths, { pid: 2222, alive: () => false });
    expect(readFileSync(paths.lock, "utf8")).toBe("2222\n");
    release();
    expect(existsSync(paths.lock)).toBe(false);
  });

  test.each([
    ["empty", ""],
    ["text", "not a pid"],
    ["a pid and more", "12 34"],
    ["zero", "0\n"],
    ["negative", "-5\n"],
  ])("a lock file that is %s is stale", (_what, content) => {
    const paths = lockPaths();
    writeTree(paths.work, { lock: content });
    const release = acquireLock(paths, { pid: 2222, alive: () => true });
    expect(readFileSync(paths.lock, "utf8")).toBe("2222\n");
    release();
  });

  test("our own pid in an old lock file (a run that died, the pid reused) is stale", () => {
    const paths = lockPaths();
    writeTree(paths.work, { lock: `${process.pid}\n` });
    const release = acquireLock(paths);
    expect(readFileSync(paths.lock, "utf8")).toBe(`${process.pid}\n`);
    release();
    expect(existsSync(paths.lock)).toBe(false);
  });

  test("a process that holds the lock cannot take it again", () => {
    const paths = lockPaths();
    const release = acquireLock(paths);
    expect(() => acquireLock(paths)).toThrow(LockError);
    expect(() => acquireLock(paths)).toThrow(/already holds the lock/);
    release();
    acquireLock(paths)(); // free again
  });

  test("a different process of ours that is told apart by pid is a live holder", () => {
    const paths = lockPaths();
    const release = acquireLock(paths, { pid: 1111 });
    expect(() => acquireLock(paths, { pid: 2222, alive: () => false })).toThrow(
      expect.objectContaining({ pid: 1111 }),
    );
    release();
  });

  test("release is idempotent and removes only a lock that is still ours", () => {
    const paths = lockPaths();
    const release = acquireLock(paths, { pid: 1111 });
    release();
    const other = acquireLock(paths, { pid: 2222 });
    release(); // the first holder releases again: it must not remove the second one's lock
    expect(readFileSync(paths.lock, "utf8")).toBe("2222\n");
    other();

    // A lock that was replaced by another owner while we held it is theirs.
    const third = acquireLock(paths, { pid: 3333 });
    writeFileSync(paths.lock, "4444\n");
    third();
    expect(readFileSync(paths.lock, "utf8")).toBe("4444\n");
  });

  test("knows a live process from a dead one (real pids)", async () => {
    const paths = lockPaths();
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
      stdio: "ignore",
    });
    try {
      expect(child.pid).toBeGreaterThan(0);
      writeTree(paths.work, { lock: `${child.pid}\n` });
      expect(() => acquireLock(paths)).toThrow(expect.objectContaining({ pid: child.pid }));
    } finally {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
    const release = acquireLock(paths); // the child is dead now
    expect(readFileSync(paths.lock, "utf8")).toBe(`${process.pid}\n`);
    release();
  });

  test("refuses a .docusystem that is a symbolic link: the CLI deletes inside it", () => {
    const paths = lockPaths();
    const elsewhere = tempDir();
    writeTree(join(paths.work, ".."), {});
    symlinkSync(elsewhere, paths.work);
    expect(() => acquireLock(paths, { pid: 1111 })).toThrow(/symbolic link/);
    expect(existsSync(join(elsewhere, "lock"))).toBe(false);
  });

  test("never writes through a symbolic link at the lock path", () => {
    const paths = lockPaths();
    const target = join(tempDir(), "target.txt");
    writeFileSync(target, "precious");
    writeTree(paths.work, {});
    symlinkSync(target, paths.lock);
    const release = acquireLock(paths, { pid: 1111, alive: () => true });
    expect(readFileSync(target, "utf8")).toBe("precious");
    expect(readFileSync(paths.lock, "utf8")).toBe("1111\n");
    release();
  });
});

describe("LockError", () => {
  test("carries the pid and has a default message that names it", () => {
    const error = new LockError(77);
    expect(error.pid).toBe(77);
    expect(error.name).toBe("LockError");
    expect(error.message).toContain("pid 77");
    expect(error).toBeInstanceOf(Error);
  });
});
