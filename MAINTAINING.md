# Maintaining @avunu/docusystem

For the people who release and look after this package. Everything here is either a fact checked against the sources it names, or a step marked as a setting, which a pull request cannot make. Anything that has not been run on GitHub yet says so, and is listed in [Verified on GitHub](#verified-on-github).

## What a pull request can do, and what a person must do

| Pull requests                                                                                                                                                                              | Settings, secrets and decisions (not code)                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Everything inside this repository: source, `site/`, the scaffold, workflows, release-please configuration, Dependabot, the zizmor policy, CODEOWNERS, SECURITY.md, docs, tests and scripts | Create or confirm the npm organization `avunu` (the `@avunu` scope) and enable two-factor authentication                                                                 |
| The migration commits for the pilot repositories, after gate G3                                                                                                                            | The first publish and the trusted-publisher attachment ([First release](#first-release))                                                                                 |
| The dogfood site (`docs-site/` and its two caller workflows), after 0.1.0 is on npm                                                                                                        | The GitHub settings of this repository ([GitHub settings](#github-settings))                                                                                             |
|                                                                                                                                                                                            | Merging every pull request, including the release pull request                                                                                                           |
|                                                                                                                                                                                            | Per adopting repository: the Pages source, custom domain, DNS `CNAME`, the variable `DOCS_SITE_ENABLED`, branch protection and the `docs:` line in the avunu.net catalog |
|                                                                                                                                                                                            | The [open decisions](#open-decisions)                                                                                                                                    |

## How a release happens

Releases are made by merging the pull request that release-please keeps open. Nothing is published from a laptop.

1. Pull requests are squash-merged to `main` with Conventional Commit titles. `ci.yml` checks the title with `scripts/check-pr-title.mjs`.
2. `release.yml` runs on every push to `main`, and daily, because a Dependabot merge made with `GITHUB_TOKEN` starts no `push` workflow. release-please, in manifest mode with one package (`.`) and `release-type: node`, keeps one pull request open, titled `chore: release v<VERSION>`, with the version bump and `CHANGELOG.md`.
3. Only `feat`, `fix`, `perf` and `revert` commits, and any commit marked breaking, make it propose a release (`release-please-config.json`, `changelog-sections`). `docs`, `style`, `refactor`, `test`, `build`, `ci` and `chore` are hidden and never release on their own. With `bump-minor-pre-major`, a breaking change before 1.0 bumps the minor.
4. After it opens or updates the release pull request, the workflow dispatches `ci.yml` on the release branch, because a pull request opened with `GITHUB_TOKEN` starts no `pull_request` workflows and the required check `ci` would otherwise never report. If the dispatch ever fails, close and reopen the release pull request, or push an empty commit to its branch from your own account.
5. Merging the release pull request creates the tag `v<VERSION>` and the GitHub Release (`include-v-in-tag: true`, `include-component-in-tag: false`, so the tag and the release are both named `v<VERSION>`).
6. In the same run the `publish` job (it needs the release job and runs only when a release was created) checks out the release commit, runs `npm ci --ignore-scripts`, `npm run check`, `npm run build` and `npm run check:pack`, then `npm publish --provenance --access public` under the `npm` environment. It skips a version that npm already has, so a retry cannot publish twice.

   The tag and the GitHub Release exist before the publish job starts, and `publish` runs only in the run in which release-please created them (it reads `release-created`, `version` and `sha` from that run's release job). To retry a failed publish, open the original run and choose **Re-run failed jobs**, which keeps those outputs. Never choose **Re-run all jobs**, start the workflow by hand or push to `main` for this: release-please then finds no merged pull request still labelled `autorelease: pending` (it relabelled it `autorelease: tagged` when it tagged), reports no release, skips `publish`, and the run is green with nothing published. A failure caused by the code at the release commit cannot be retried, because the tag `v<VERSION>` stays on that commit: it needs a `fix:` commit and the next release (0.1.1 after a failed 0.1.0). Afterwards confirm the result with `npm view @avunu/docusystem@<VERSION> _npmUser`.

Publishing lives in the same file as release-please because npm trusted publishing validates the workflow file name of the run, and tags created with `GITHUB_TOKEN` start no tag workflows. The publish job has `contents: read` and `id-token: write` and nothing else. There is no major-tag job and no moving tag: callers pin a commit.

Provenance: `publishConfig.provenance: true` plus `id-token: write` signs every release. That also holds for a token-authenticated publish, so the provenance gate in `docs-build.yml` passes for the first release too.

The publish step keeps `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` wired for route A of the first release. With route B the secret does not exist, the value is an empty string and is inert, because npm tries the OIDC exchange first. A follow-up pull request deletes the line after the first release that needed no token.

Versions: the first release is 0.1.0 (the first `feat:` commit after the manifest's `0.0.0`). Stay on 0.x until the criteria in [Before 1.0](#before-10) hold, then add a commit to `main` whose body ends with `Release-As: 1.0.0`.

> [!WARNING]
> Do not put a raw HTML tag in a commit title or a `BREAKING CHANGE:` note. release-please re-parses its own release notes as HTML and silently skips a commit that has one. `check-pr-title.mjs` rejects it; write "the picture element" instead of the tag.

## First release

Steps 1 to 3 are settings, not code. Do them before the release pull request is merged.

1. **npm organization.** Create the organization `avunu` at <https://www.npmjs.com/org/create> (free for public packages), enable two-factor authentication on your account, and confirm that the scope is yours. As of 2026-10-06 `npm view @avunu/docusystem` and `npm search scope:avunu` return nothing, and Avunu's other `@avunu/*` packages are on GitHub Packages, which needs a token even to install a public package.
2. **Route B, recommended: no secret ever.** Publish a placeholder so that the package exists, then attach the trusted publisher before the first real release. A trusted publisher can only be attached to a package that already exists.

   ```bash
   npm login                            # you, with 2FA
   mkdir docusystem-placeholder && cd docusystem-placeholder
   printf '%s\n' '{"name":"@avunu/docusystem","version":"0.0.0","description":"Placeholder. The real package is published from https://github.com/Avunu/docusystem by GitHub Actions.","license":"MIT","repository":{"type":"git","url":"git+https://github.com/Avunu/docusystem.git"}}' > package.json
   npm publish --access public          # you, with 2FA
   npm deprecate @avunu/docusystem@0.0.0 "Placeholder: install a newer version"
   npm trust github @avunu/docusystem --repo Avunu/docusystem --file release.yml --env npm --allow-publish
   ```

   `npm trust` needs npm 11.15 or newer and account 2FA (tokens that bypass 2FA are refused). The same settings are on npmjs.com under the package, Settings, Trusted publisher: organization `Avunu`, repository `docusystem`, workflow filename `release.yml`, environment `npm`.

   **Route A, alternative:** create a granular access token (read and write, scope `@avunu`, "Bypass 2FA", default 7-day expiry) and store it as the secret `NPM_TOKEN` of the GitHub environment `npm`. Merge the first release pull request. Then attach the trusted publisher, set "Require two-factor authentication and disallow tokens", delete the secret and revoke the token.

3. **GitHub settings** of this repository: see [GitHub settings](#github-settings).
4. **Merge** the implementation pull requests (gate G1 below), then merge the release pull request `chore: release v0.1.0`. `release.yml` tags `v0.1.0`, creates the GitHub Release and publishes with provenance through OIDC.
5. **Verify.**
   - `npm view @avunu/docusystem@0.1.0 _npmUser` shows `GitHub Actions <npm-oidc-no-reply@github.com>` with a `trustedPublisher` entry.
   - In a scratch directory, `npm install @avunu/docusystem@0.1.0 --ignore-scripts` and then `npm audit signatures --include-attestations` reports a verified provenance attestation.
   - `git ls-remote https://github.com/Avunu/docusystem refs/tags/v0.1.0` returns the commit that `docusystem init` will pin.
6. **Close the door** (route B): in the package settings choose "Require two-factor authentication and disallow tokens".

Requirements npm documents for trusted publishing: npm CLI 11.5.1 or newer and Node 22.14 or newer on the runner (Node 24 ships npm 11), GitHub-hosted runners and `id-token: write` on the publishing job. The npm CLI tries the OIDC exchange first whenever it runs in GitHub Actions with that permission, and falls back to a configured token only when the exchange fails.

## GitHub settings

State of `Avunu/docusystem` read on 2026-10-06: public; auto-merge off; secret scanning, push protection, Dependabot security updates and private vulnerability reporting disabled; no rulesets and no environments; default workflow permission `read`; "Actions may create and approve pull requests" on (release-please needs it).

1. **Settings, General, Pull Requests.** Allow squash merging only, with "Pull request title and description" as the default commit message (so that a `BREAKING CHANGE:` note in the body reaches the commit), and delete head branches on merge.
2. **Settings, Code security.** Enable Dependabot alerts and security updates, secret scanning with push protection, and **private vulnerability reporting** ([SECURITY.md](SECURITY.md) points at it).
3. **Settings, Rules, Rulesets, branch `main`.** Require a pull request, require the status check `ci` and no other, block force pushes and deletion.
4. **Settings, Rules, Rulesets, tags `v*.*.*`.** Restrict updates and deletions, so that a released tag can never move.
5. **Settings, General, Releases.** Turn on release immutability.
6. **Settings, Environments.** Create `npm`, with deployment branches limited to `main`. It holds no secret once the first release is done.
7. **Settings, Actions, General.** Turn on "Require actions to be pinned to a full-length commit SHA" (every `uses:` in this repository already is). Leave the default workflow permission at `read`.

A public repository can call a reusable workflow only from a public repository, and a private repository can call a public one. A caller's organization needs "allow actions and reusable workflows" to include `Avunu/docusystem/*` if it restricts Actions to a list.

## Gates

The order matters, because a thin shell needs a published package, a release tag and a lockfile that records the registry's integrity hash.

| Gate | Condition                                                                                                                                  | Who                                          |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| G1   | The implementation pull requests are merged to `main` and `ci` is green on `main`                                                          | A maintainer merges                          |
| G2   | The npm organization, placeholder, trusted publisher and GitHub settings above are in place                                                | A maintainer                                 |
| G3   | The release pull request is merged, the tag `v0.1.0` exists and `@avunu/docusystem@0.1.0` is on npm with a verified provenance attestation | A maintainer merges; `release.yml` publishes |
| G4   | The proof pilot passes the GitHub checks in [Verified on GitHub](#verified-on-github)                                                      | An agent runs it, a maintainer merges        |
| G5   | The other pilots migrate, then the rest of the fleet, then the dogfood site                                                                | Agents; a maintainer merges                  |

The pilots are the first three repositories to adopt the system: `frappe-nix`, `erpnext_taskview` and `cloudflare-email-relay`. No pilot is changed until G3 holds. The proof pilot is `cloudflare-email-relay`, whose docs and workflows are the smallest.

## Verified on GitHub

These GitHub behaviors have never been run. Confirm them on the proof pilot (gate G4) and record each result here in the pull request that confirms it. Until then the result is a placeholder.

| #   | Behavior to confirm                                                                                                                                                                                                                                                                                                                   | Result        | Date          | Evidence      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ------------- | ------------- |
| 1   | `docs.yml` starts and its `build` job passes on a Dependabot-authored `pull_request` (bump `@avunu/docusystem` in the pilot to trigger one) and on a pull request from a fork, with a read-only token and no secrets                                                                                                                  | [PLACEHOLDER] | [PLACEHOLDER] | [PLACEHOLDER] |
| 2   | On a push to the default branch, `docs-publish.yml` builds without deploying while `DOCS_SITE_ENABLED` is unset, then builds and deploys once it is `true`; `configure-pages` and `deploy-pages` work from `docs-deploy.yml`; the Pages artifact uploaded in the called build job is visible to the called deploy job of the same run | [PLACEHOLDER] | [PLACEHOLDER] | [PLACEHOLDER] |
| 3   | The path filter of `docs.yml` means `build / Check` is not reported on pull requests that touch no docs path, so it cannot be a required status as it stands (see open decision 7)                                                                                                                                                    | [PLACEHOLDER] | [PLACEHOLDER] | [PLACEHOLDER] |
| 4   | If `build / Check` is ever made required: a job skipped by `if` (a push to a non-default branch) counts as passing                                                                                                                                                                                                                    | [PLACEHOLDER] | [PLACEHOLDER] | [PLACEHOLDER] |
| 5   | The organization-level "allow actions and reusable workflows" policy permits `Avunu/docusystem/*`                                                                                                                                                                                                                                     | [PLACEHOLDER] | [PLACEHOLDER] | [PLACEHOLDER] |
| 6   | The release flow: release-please opens `chore: release v0.1.0`, the dispatched `ci` run attaches to its branch, merging tags `v0.1.0`, and `publish` succeeds through OIDC with provenance                                                                                                                                            | [PLACEHOLDER] | [PLACEHOLDER] | [PLACEHOLDER] |

Also not verified anywhere yet, and therefore gated: npm trusted publishing and provenance, macOS, release-please's behavior with this configuration, and the registry install of the published package. Windows is unsupported.

If row 2 fails because the deploy job cannot call a reusable workflow that asks for `pages: write` and `id-token: write`, the fallback is documented in [Workflows](docs/reference/workflows.md#if-a-called-deploy-job-is-rejected): only `docs-publish.yml` changes.

## Updating Jx and the catalog

The package pins the exact Jx versions it was tested with, so a Jx release reaches a documentation site in this order: Dependabot here (group `jx`, prefix `fix(deps)`) opens a pull request; `ci` builds everything against it, including the real-Jx canary, the consumer matrix and the browser suites; a person merges; release-please proposes a patch release; the fleet job runs on the release pull request; the release publishes; each site's own Dependabot opens a grouped pull request. `jx-latest.yml` installs the latest `@jxsuite/*` over the pins every week and opens an issue when the canary or the example build fails: that is the early warning for a Jx release that Dependabot has not proposed yet.

The project switcher's catalog is bundled. `catalog.yml` runs weekly, regenerates `site/data/projects.snapshot.json` with `npm run sync-catalog`, and when the file changed pushes a branch `fix/catalog-<date>` with the commit `fix(catalog): refresh the bundled project catalog`, opens a pull request and dispatches `ci.yml` on it. A release then carries the refresh. The script treats an HTTP 404 or an invalid document as "no change": the live `projects.json` of avunu.net is not published yet.

The fleet job (`fleet.yml`, and on `release-please--*` branches as part of `ci.yml`) adopts every repository in `fleet.json` from its README and runs `check`. On a release branch every repository must pass or be named in `fleet.expected-failures.json` with a reason; re-read that file at each release.

## Before 1.0

Release 1.0.0 only when:

- the three pilot repositories (`frappe-nix`, `erpnext_taskview` and `cloudflare-email-relay`) are deployed on a released version;
- one Dependabot-authored docusystem upgrade pull request has run its checks on GitHub;
- the fleet job is green on every repository in `fleet.json`;
- the first provenance-signed release exists;
- the GitHub behaviors in [Verified on GitHub](#verified-on-github) are confirmed.

Until then a minor release may break anything except the workflow-contract rule, and callers pin exact commits anyway. See [Versioning and compatibility](docs/reference/versioning.md) for the whole policy.

## Open decisions

Each has a default in force, so that nothing is blocked.

| #   | Decision                                                                                                                                                           | Default in force                                                                                                     | Blocks                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| 1   | npm scope and first publish: route B (placeholder, then `npm trust`) or route A (a 7-day token as an environment secret)                                           | Route B                                                                                                              | G2, every pilot            |
| 2   | The GitHub settings above                                                                                                                                          | Cannot be a pull request                                                                                             | G2                         |
| 3   | Package license, owner and contact                                                                                                                                 | MIT, "Copyright (c) 2026 Avunu LLC", CODEOWNERS naming a maintainer's handle, SECURITY.md with a placeholder mailbox | The contact in SECURITY.md |
| 4   | Pilot lockfiles move from Bun to npm, because Dependabot cannot update Bun 1.4's lockfile and the provenance check needs npm                                       | Yes; Bun stays supported for running the CLI                                                                         | The pilot migrations       |
| 5   | Image optimization default                                                                                                                                         | `images: "optimize"`, with `images: "off"` documented and a hint printed on failure                                  |                            |
| 6   | Catalog freshness                                                                                                                                                  | Bundled, refreshed weekly as a patch release                                                                         |                            |
| 7   | A required docs check: drop the path filter of `docs.yml` so that the check always reports, then require it and drop the auto-merge exclusion                      | Keep the exclusion through the pilots, revisit after G5                                                              |                            |
| 8   | Organization-level domain verification of `avunu.net` plus one wildcard `*.avunu.net` `CNAME` to `avunu.github.io`, which would remove the per-repository DNS step | The per-repository flow, which works without it                                                                      |                            |
| 9   | The 1.0.0 criteria above                                                                                                                                           | As listed                                                                                                            |                            |
| 10  | The domain of this package's own documentation                                                                                                                     | `docusystem.avunu.net` (DNS and Pages enablement are a maintainer's)                                                 | The dogfood site           |
| 11  | Whether to file the [Jx upstream asks](docs/maintainers/upstream-asks.md)                                                                                          | Undecided                                                                                                            |                            |
| 12  | Shared brand foundations in one package (`@avunu/brand`: tokens, fonts, marks, the contrast library and the `projects.json` schema)                                | Later, separately; not part of this system                                                                           |                            |
| 13  | The proof pilot for G4                                                                                                                                             | `cloudflare-email-relay`                                                                                             | G4                         |

## Facts the design rests on

Measured by the prototypes on 2026-10-06 with Node 22, 24 and 26, Bun 1.4.2 and npm 11; `npm run test:pack` repeats them against the packed tarball.

- Node refuses TypeScript inside `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`) on 22, 24 and 26, so the package ships compiled JavaScript with declarations. Bun runs the same output.
- Jx reads `components/`, `pages/` and `public/` only from the project root, and `copy` takes files, not folders, so the package cannot supply them from `node_modules`. The CLI assembles a root from real copies. See [Build pipeline](docs/reference/build-pipeline.md).
- With an isolated linker (pnpm, `bun install --linker isolated`) a transitive dependency is not visible from the project. The CLI links the Jx packages it was installed with into the assembled root, which fixes it, and also means that the docs system always builds with its own pinned Jx even if a project lists a different one.
- Dependabot cannot update a `bun.lock` of `lockfileVersion` 2, which is what Bun 1.4 writes for a new lockfile (`MAX_SUPPORTED_LOCKFILE_VERSION = 1` in dependabot-core on 2026-10-06; the fix, dependabot-core pull request 16071, was unmerged). Projects therefore use `package-lock.json`, and the reusable workflow refuses a Bun lockfile.
- `@jxsuite/server` is not a dependency: it adds 59 lockfile entries and about 70 MB for a development server nobody needs. `docusystem dev` serves the finished build itself.
- A published package ignores its own lockfile, so the exact pins in `dependencies` are how the tested Jx set reaches consumers.
