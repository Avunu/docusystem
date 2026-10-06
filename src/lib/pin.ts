// Pinning the shared workflows (section 4.4 and 7.3 of the architecture decision record). A caller
// workflow names the reusable workflows of Avunu/docusystem by a 40-character commit, never by a tag
// or a branch (a tag can move; the deploy job holds `pages: write` and `id-token: write`), and says
// the version in a trailing comment so that a person and Dependabot can read what the pin is. `init`
// and `upgrade` write the pins; this module finds the commit of a release and rewrites `uses:` lines.
import { tmpdir } from "node:os";
import { runGit } from "./gitremote.js";
import { REPOSITORY } from "./package-info.js";

/** `MAJOR.MINOR.PATCH`, with an optional pre-release. The only version text that is ever put in a git ref. */
export const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** A full commit id, lower case. */
export const COMMIT = /^[0-9a-f]{40}$/;

/** `0.1.0` or `v0.1.0` as `0.1.0`; null when it is not a version. */
export function bareVersion(version: string): string | null {
  const bare = version.trim().replace(/^v/, "");
  return SEMVER.test(bare) ? bare : null;
}

/** The tag of a release: `v0.1.0`. */
export function tagOf(version: string): string {
  const bare = bareVersion(version);
  if (bare === null) throw new Error(`"${version}" is not a version (MAJOR.MINOR.PATCH)`);
  return `v${bare}`;
}

export interface PinResult {
  /** The commit of the tag, 40 lower-case hex digits; null when it could not be found. */
  sha: string | null;
  /** Why not, as a sentence; null when `sha` is set. */
  reason: string | null;
}

/**
 * The commit of tag `v<version>` of Avunu/docusystem: `git ls-remote <repository> refs/tags/v<version>^{}
 * refs/tags/v<version>`, preferring the peeled line (an annotated tag's own id is not a commit).
 * `lsRemote` receives the whole git argument list and returns git's standard output, or throws; it is
 * injectable so that tests and offline runs need no network. Never throws.
 */
export function resolvePin(
  version: string,
  o: { lsRemote?: (args: string[]) => string; env?: NodeJS.ProcessEnv } = {},
): PinResult {
  const bare = bareVersion(version);
  if (bare === null) return { sha: null, reason: `"${version}" is not a version` };
  const tag = `refs/tags/v${bare}`;
  const args = ["ls-remote", `https://github.com/${REPOSITORY}`, `${tag}^{}`, tag];
  let output: string;
  try {
    output = (o.lsRemote ?? ((a) => gitLsRemote(a, o.env)))(args);
  } catch (error) {
    return {
      sha: null,
      reason: `could not ask ${REPOSITORY} for the tag v${bare} (${(error as Error).message.trim()})`,
    };
  }
  let lightweight: string | null = null;
  let peeled: string | null = null;
  for (const line of output.split("\n")) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (sha === undefined || ref === undefined || !COMMIT.test(sha)) continue;
    if (ref === `${tag}^{}`) peeled = sha;
    else if (ref === tag) lightweight = sha;
  }
  const sha = peeled ?? lightweight;
  return sha === null
    ? { sha: null, reason: `${REPOSITORY} has no tag v${bare}` }
    : { sha, reason: null };
}

/** The commit of tag `v<version>` of Avunu/docusystem (`git ls-remote`, injectable), or null. */
export function resolveWorkflowPin(
  version: string,
  o?: { lsRemote?: (args: string[]) => string; env?: NodeJS.ProcessEnv },
): string | null {
  return resolvePin(version, o).sha;
}

function gitLsRemote(args: string[], env: NodeJS.ProcessEnv | undefined): string {
  // Run from a neutral folder: the configuration of the repository the command runs in is not
  // trusted (a `url.<base>.insteadOf` there could send the question to another server).
  const result = runGit(args, { cwd: tmpdir(), env: env ?? process.env, timeoutMs: 30_000 });
  if (result.missing) throw new Error("git is not installed or not on PATH");
  if (result.status !== 0) {
    throw new Error(result.stderr.trim().split("\n")[0] || `git exited with ${result.status}`);
  }
  return result.stdout;
}

/**
 * A `uses:` line of a job that calls a reusable workflow of this repository:
 * `    uses: Avunu/docusystem/.github/workflows/docs-build.yml@<ref> # <comment>`.
 */
const USES_LINE = new RegExp(
  String.raw`^([ \t]*(?:-[ \t]+)?uses:[ \t]*)(${REPOSITORY.replace("/", "\\/")}\/\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml)@([^\s#]+)([ \t]*#[^\r\n]*)?(?=\r?$)`,
  "gm",
);

/**
 * Re-pins every `uses: Avunu/docusystem/.github/workflows/<file>@<ref>` line of a caller workflow to
 * `<sha> # v<version>` and returns the new text (equal to `text` when everything is pinned there
 * already); null when the file has no such line. Nothing else is touched.
 */
export function repinWorkflow(text: string, sha: string, version: string): string | null {
  if (!COMMIT.test(sha)) throw new Error(`repinWorkflow: "${sha}" is not a full commit id`);
  const tag = tagOf(version);
  let found = false;
  const next = text.replace(USES_LINE, (_line, head: string, file: string) => {
    found = true;
    return `${head}${file}@${sha} # ${tag}`;
  });
  return found ? next : null;
}
