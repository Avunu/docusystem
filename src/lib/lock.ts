// STUB owned by WP2: the signatures are frozen (Appendix B of the architecture decision record); the
// bodies are the work package's to write and replace the throws below. WP0 never edits this file again.
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

/** Takes the pid-file lock (a dead pid is replaced) and returns the function that releases it. */
export function acquireLock(
  _paths: Pick<Paths, "work" | "lock">,
  _o?: { pid?: number; alive?: (pid: number) => boolean },
): () => void {
  throw new Error("not implemented (WP2)");
}
