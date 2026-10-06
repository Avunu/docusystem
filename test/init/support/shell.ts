// Helpers for the tests of init, upgrade, doctor and eject: temporary git repositories with an
// `origin` remote, copies of the real `.github` files of the three pilot repositories, and a way to
// run a command in-process with an empty environment (git gets PATH and a HOME of its own).
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CommandContext, CommandOptions } from "../../../src/commands/types.js";
import {
  initRepo,
  listTree,
  tempDir,
  testContext,
  writeTree,
  type TreeSpec,
} from "../../support/index.js";
import { initFixture } from "./fixtures.js";

/** Placeholder commits: what a test passes as the release commit. */
export const SHA = "0123456789abcdef0123456789abcdef01234567";
export const SHA2 = "fedcba9876543210fedcba9876543210fedcba98";

export const PILOTS = ["cloudflare-email-relay", "erpnext_taskview", "frappe-nix"] as const;

/**
 * A fresh git repository. `origin` is its remote (default: the frappe-nix repository, which is in the
 * catalog); null gives none. `files` are written under the root.
 */
export function makeRepo(o: { origin?: string | null; files?: TreeSpec } = {}): string {
  const root = tempDir("docusystem-init-");
  initRepo(
    root,
    o.origin === null ? {} : { origin: o.origin ?? "https://github.com/Avunu/frappe-nix.git" },
  );
  if (o.files !== undefined) writeTree(root, o.files);
  return root;
}

/** The `.github` folder of a pilot, as it was before its migration, copied into `root`. */
export function copyPilotGithub(root: string, pilot: (typeof PILOTS)[number]): void {
  cpSync(initFixture("pilots", pilot, ".github"), join(root, ".github"), { recursive: true });
}

/** What a command may read of the environment in a test: PATH for git, and a HOME that is the repository. */
export const envFor = (root: string): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH ?? "",
  HOME: root,
});

export interface Ran {
  code: number;
  /** Standard output and standard error, one string each. */
  out: string;
  err: string;
}

/** Runs a command's `run` function in-process in `cwd` and collects what it printed. */
export async function exec(
  run: (ctx: CommandContext) => Promise<number>,
  o: {
    command: string;
    cwd: string;
    options?: CommandOptions;
    args?: string[];
    env?: NodeJS.ProcessEnv;
  },
): Promise<Ran> {
  const { ctx, stdout, stderr } = testContext({
    command: o.command,
    cwd: o.cwd,
    env: o.env ?? envFor(o.cwd),
    options: o.options ?? {},
    args: o.args ?? [],
  });
  const code = await run(ctx);
  return { code, out: stdout.join("\n"), err: stderr.join("\n") };
}

/** The text of a file of the repository, or null when it does not exist. */
export function readIn(root: string, rel: string): string | null {
  const file = join(root, ...rel.split("/"));
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

/** The files `init` writes into a repository without a `.github` folder of its own. */
export const SHELL_FILES = [
  "docs-site/docusystem.config.json",
  "docs-site/package.json",
  "docs-site/.gitignore",
  ".github/workflows/docs.yml",
  ".github/workflows/docs-publish.yml",
  ".github/dependabot.yml",
] as const;

/** Everything in the repository except git's own folder, sorted: files as `path`, folders as `path/`. */
export const worktree = (root: string): string[] =>
  listTree(root).filter((entry) => entry !== ".git/" && !entry.startsWith(".git/"));

/** Replaces the text of a file of the repository. */
export function rewrite(root: string, rel: string, change: (text: string) => string): void {
  const file = join(root, ...rel.split("/"));
  writeFileSync(file, change(readFileSync(file, "utf8")));
}
