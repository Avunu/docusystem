import { spawnSync } from "node:child_process";

/**
 * Runs git in `cwd` and returns its trimmed standard output; throws with git's message when it fails.
 * The environment is hermetic (no user or system configuration), and commits work without an identity.
 */
export function git(cwd: string, ...args: string[]): string {
  const result = spawnSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "init.defaultBranch=main",
      ...args,
    ],
    {
      cwd,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: cwd,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
      },
    },
  );
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr || result.error}`);
  }
  return result.stdout.trim();
}

/** `git init` in `dir` (which must exist), with an `origin` remote when one is given. */
export function initRepo(dir: string, o: { origin?: string; branch?: string } = {}): string {
  git(dir, "init", "--initial-branch", o.branch ?? "main");
  if (o.origin !== undefined) git(dir, "remote", "add", "origin", o.origin);
  return dir;
}
