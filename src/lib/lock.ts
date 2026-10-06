// The pid-file lock of a site folder (step 3 of the pipeline, 5.1 of the architecture decision record).
//
// One process at a time may write `<site>/.docusystem/`: a `check` that recreates the root and `dist/`
// under a running dev server, or under a browser test, produces half-built pages. The lock is the file
// `<site>/.docusystem/lock` holding the pid of its owner:
//
// - a lock whose pid is dead, or whose content is not a pid, is stale and is replaced;
// - a lock whose pid is alive is refused, naming the pid (exit code 3 in the CLI);
// - the file is created exclusively (`wx`), so two processes that start at the same instant cannot
//   both believe they own it;
// - a process that already holds a lock cannot take it again: that is a bug in the caller (two runs
//   overlapping in one process would both be rewriting the root), not a stale file.
//
// The pipeline releases the lock in a `finally`; a process that is killed leaves a file with a dead pid,
// which the next run replaces.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ensureRealDir } from "./fsutil.js";
import type { Paths } from "./types.js";

/** Another docusystem process holds the lock: `pid` is its pid (exit code 3). */
export class LockError extends Error {
  pid: number;

  constructor(pid: number, message = `another docusystem process (pid ${pid}) is running`) {
    super(message);
    this.name = "LockError";
    this.pid = pid;
  }
}

/** The locks this process holds: absolute lock path to the pid it was taken with. */
const held = new Map<string, number>();

/** Whether a process with this pid exists (EPERM means it exists and belongs to someone else). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Blocks the thread for `ms` milliseconds. */
function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * The pid written in the lock file; `undefined` when there is no file; `null` when the file is not a
 * pid. A file that is empty or garbled might be one that its creator has not finished writing, so it
 * is looked at a few times before it is believed.
 */
function readHolder(file: string): number | null | undefined {
  for (let attempt = 0; attempt < 4; attempt++) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code === "ENOENT" || code === "ENOTDIR" ? undefined : null;
    }
    const match = /^(\d+)\s*$/.exec(text);
    const pid = match === null ? 0 : Number(match[1]);
    if (Number.isSafeInteger(pid) && pid > 0) return pid;
    if (attempt < 3) sleep(15);
  }
  return null;
}

/** The message of a refusal: names the holder, says what to do, and how to clear a lock that is not real. */
function busy(holder: number, work: string, file: string): string {
  return (
    `another docusystem process (pid ${holder}) is using ${work}; wait for it or stop it ` +
    "(a running `docusystem dev` serves the site: use its address instead of building again). " +
    `If no docusystem process is running, delete ${file}`
  );
}

/** Creates the lock file; false when it exists already. Never writes through a symbolic link. */
function create(file: string, pid: number): boolean {
  try {
    writeFileSync(file, `${pid}\n`, { flag: "wx", mode: 0o644 });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

/**
 * Takes the pid-file lock and returns the function that releases it. A dead pid is replaced; a live
 * one throws LockError naming it. `o.pid` and `o.alive` are for tests (the pid to write, and how to
 * tell whether another pid is alive).
 *
 * `<site>/.docusystem/` must be a real folder (it is created when it is absent): the CLI later deletes
 * inside it, and a link committed in its place must not be followed.
 */
export function acquireLock(
  paths: Pick<Paths, "work" | "lock">,
  o: { pid?: number; alive?: (pid: number) => boolean } = {},
): () => void {
  const pid = o.pid ?? process.pid;
  const alive = o.alive ?? isAlive;
  const file = resolve(paths.lock);
  ensureRealDir(paths.work);
  mkdirSync(dirname(file), { recursive: true });

  const owner = held.get(file);
  if (owner !== undefined && readHolder(file) === owner) {
    throw new LockError(
      owner,
      owner === pid
        ? `docusystem (pid ${owner}) already holds the lock ${file} in this process: two runs on one site folder at once would rewrite the same files`
        : busy(owner, paths.work, file),
    );
  }
  held.delete(file);

  let last = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (create(file, pid)) {
      held.set(file, pid);
      return () => {
        if (held.get(file) !== pid) return; // released already
        held.delete(file);
        // Only a lock that is still ours: a stale-looking lock replaced by another process is theirs.
        if (readHolder(file) === pid) rmSync(file, { force: true });
      };
    }
    const holder = readHolder(file);
    if (holder === undefined) continue; // it was released between our two looks
    if (holder !== null) {
      last = holder;
      if (holder !== pid && alive(holder)) {
        throw new LockError(holder, busy(holder, paths.work, file));
      }
    }
    rmSync(file, { force: true }); // stale: a dead pid, text that is not a pid, or our own pid from a run that died
  }
  throw new LockError(last, `could not take the lock ${file}: it keeps changing; try again`);
}
