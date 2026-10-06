// What `init` and `upgrade` need to know about the git repository they run in: where its root is, what
// its `origin` remote is, and a way to run git with the environment the command was given. Git is the
// only program the package runs besides Jx, and only these two commands (init and upgrade) do it
// (section 4.1: "`init` and `upgrade` need `git` on `PATH`").
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * `git@github.com:o/n.git`, `ssh://git@github.com/o/n`, `git://github.com/o/n.git` and
 * `https://[user[:token]@]github.com/o/n[.git][/]` all become `https://github.com/o/n`; null for
 * anything else (another host, a path, a malformed remote). The result never carries credentials, so
 * it is safe to print and to write into a configuration file.
 */
export function normalizeRemote(remote: string): string | null {
  const text = remote
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
  const owner = String.raw`([A-Za-z0-9][\w.-]*)`;
  const name = String.raw`([\w.-]+)`;
  const forms = [
    // scp-like: [user@]github.com:owner/name
    new RegExp(String.raw`^(?:[\w.-]+@)?github\.com:${owner}/${name}$`, "i"),
    // URL forms, with an optional user (and password) and port
    new RegExp(
      String.raw`^(?:ssh|git|https)://(?:[^@/\s]+@)?github\.com(?::\d+)?/${owner}/${name}$`,
      "i",
    ),
  ];
  for (const form of forms) {
    const match = form.exec(text);
    if (match === null) continue;
    const [, who, what] = match;
    if (who === undefined || what === undefined || what === "." || what === "..") return null;
    return `https://github.com/${who}/${what}`;
  }
  return null;
}

/** The repository's name (the last segment of `https://github.com/<owner>/<name>`). */
export function repoName(repo: string): string {
  return repo.slice(repo.lastIndexOf("/") + 1);
}

/** The nearest folder at or above `start` that contains `.git` (a folder, or a file in a worktree), or null. */
export function gitRootOf(start: string): string | null {
  let dir: string;
  try {
    dir = realpathSync(resolve(start));
  } catch {
    return null;
  }
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export interface GitResult {
  /** The exit status, or null when git could not be started or was killed. */
  status: number | null;
  stdout: string;
  stderr: string;
  /** git is not installed (or not on PATH). */
  missing: boolean;
}

/**
 * Runs `git <args>` in `cwd`. The child sees only PATH and HOME of `env` (and never prompts), so a
 * token in the caller's environment does not reach it. A hanging remote ends after `timeoutMs`.
 */
export function runGit(
  args: string[],
  o: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): GitResult {
  const source = o.env ?? {};
  const env: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: "0" };
  if (source.PATH !== undefined) env.PATH = source.PATH;
  if (source.HOME !== undefined) env.HOME = source.HOME;
  const result = spawnSync("git", args, {
    cwd: o.cwd,
    env,
    encoding: "utf8",
    timeout: o.timeoutMs ?? 30_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    missing: code === "ENOENT",
  };
}

/** The URL of the `origin` remote of the repository at `repoRoot`, or null (no remote, no git). */
export function originRemote(repoRoot: string, env?: NodeJS.ProcessEnv): string | null {
  const result = runGit(["remote", "get-url", "origin"], { cwd: repoRoot, env });
  if (result.status !== 0) return null;
  const url = result.stdout.trim();
  return url === "" ? null : url;
}
