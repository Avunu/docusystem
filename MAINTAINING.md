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
|                                                                                                                                                                                            | Once for the organization: verify `avunu.net` for GitHub Pages ([Domains](#domains-of-the-documentation-sites))                                                          |
|                                                                                                                                                                                            | The [open decisions](#open-decisions)                                                                                                                                    |

## How a release happens

Releases are made by merging the pull request that release-please keeps open. Nothing is published from a laptop.

1. Pull requests are squash-merged to `main` with Conventional Commit titles. `ci.yml` checks the title with `scripts/check-pr-title.mjs`.
2. `release.yml` runs on every push to `main`, and daily, because a Dependabot merge made with `GITHUB_TOKEN` starts no `push` workflow. release-please, in manifest mode with one package (`.`) and `release-type: node`, keeps one pull request open, titled `chore: release v<VERSION>`, with the version bump and `CHANGELOG.md`.
3. Only `feat`, `fix`, `perf` and `revert` commits, and any commit marked breaking, make it propose a release (`release-please-config.json`, `changelog-sections`). `docs`, `style`, `refactor`, `test`, `build`, `ci` and `chore` are hidden and never release on their own. With `bump-minor-pre-major`, a breaking change before 1.0 bumps the minor.
4. After it opens or updates the release pull request, the workflow dispatches `ci.yml` on the release branch, because a pull request opened with `GITHUB_TOKEN` starts no `pull_request` workflows and the required check `ci` would otherwise never report. If the dispatch ever fails, close and reopen the release pull request, or push an empty commit to its branch from your own account.
5. Merging the release pull request creates the tag `v<VERSION>` and the GitHub Release (`include-v-in-tag: true`, `include-component-in-tag: false`, so the tag and the release are both named `v<VERSION>`).
6. In the same run, two more jobs run only when a release was created (both need the release job). `build` checks out the release commit, runs `npm ci --ignore-scripts`, `npm run check`, `npm run build` and `npm run check:pack`, packs the tarball (`npm pack --ignore-scripts`) and uploads it as an artifact of the run. `publish` (it needs both jobs) downloads that tarball, confirms that its `package.json` names `@avunu/docusystem` at the version release-please released, and runs `npm publish <tarball> --provenance --access public` under the `npm` environment. It skips a version that npm already has, so a retry cannot publish twice.

   The tag and the GitHub Release exist before `build` starts, and `build` and `publish` run only in the run in which release-please created them (they read `release-created`, `version` and `sha` from that run's release job). To retry a failed `build` or `publish`, open the original run and choose **Re-run failed jobs**, which keeps those outputs and the tarball that `build` uploaded (an artifact is kept 7 days; after that the download fails, and the recovery is the same as for a code failure, below). Never choose **Re-run all jobs**, start the workflow by hand or push to `main` for this: release-please then finds no merged pull request still labelled `autorelease: pending` (it relabelled it `autorelease: tagged` when it tagged), reports no release, skips `build` and `publish`, and the run is green with nothing published. A failure caused by the code at the release commit cannot be retried, because the tag `v<VERSION>` stays on that commit: it needs a `fix:` commit and the next release (0.1.1 after a failed 0.1.0). Afterwards confirm the result with `npm view @avunu/docusystem@<VERSION> _npmUser`.

Publishing lives in the same file as release-please because npm trusted publishing validates the workflow file name of the run, and tags created with `GITHUB_TOKEN` start no tag workflows. There is no major-tag job and no moving tag: callers pin a commit.

The build and the publish are separate jobs because every step of a job that has `id-token: write` can read the variables npm exchanges for a publish credential. `build` installs and runs the whole development toolchain (about 280 packages) and has no `id-token`, no environment and no secret, so no code in it can obtain a publish credential. `publish` has `id-token: write` and nothing else, checks nothing out, installs nothing and publishes a file: `npm publish <tarball>` runs no `prepack` or `prepublishOnly`, so no script of this repository or of a dependency runs where the token is. What this does not change: the tarball is still made by `build`, so a compromised development dependency could alter its content. The controls on the content are `--ignore-scripts`, the 7-day Dependabot cooldown, `check:pack`, and the human merge of the release pull request. The provenance attestation says which workflow run published the file, not that the file is what the source builds.

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

3. **GitHub settings** of this repository: see [GitHub settings](#github-settings). Two of them decide how the first release goes and cost something if left for later: the environment `npm` (create it first; step 6 there) and the merge method (squash only; step 1 there).
4. **Merge** the implementation pull requests (gate G1 below), then merge the release pull request `chore: release v0.1.0` as described in [Merging the release pull request](#merging-the-release-pull-request): squash, and no edit to its title or description. `release.yml` tags `v0.1.0`, creates the GitHub Release and publishes with provenance through OIDC.
5. **Verify.**
   - `npm view @avunu/docusystem@0.1.0 _npmUser` shows `GitHub Actions <npm-oidc-no-reply@github.com>` with a `trustedPublisher` entry.
   - In a scratch directory, `npm install @avunu/docusystem@0.1.0 --ignore-scripts` and then `npm audit signatures --include-attestations` reports a verified provenance attestation.
   - `git ls-remote https://github.com/Avunu/docusystem refs/tags/v0.1.0` returns the commit that `docusystem init` will pin.
6. **Close the door** (route B): in the package settings choose "Require two-factor authentication and disallow tokens".

Requirements npm documents for trusted publishing: npm CLI 11.5.1 or newer and Node 22.14 or newer on the runner (Node 24 ships npm 11), GitHub-hosted runners and `id-token: write` on the publishing job. The npm CLI tries the OIDC exchange first whenever it runs in GitHub Actions with that permission, and falls back to a configured token only when the exchange fails.

**Check the trusted publisher before merging the release pull request (step 4).** No pull request and no agent can read the record: `npm trust list` asks for interactive two-factor authentication, and nothing else shows it until a publish runs. Run `npm trust list @avunu/docusystem` yourself, or open the package's Settings, Trusted publisher, on npmjs.com. It must show one GitHub Actions record with these values, because npm compares each with the OIDC token of the publishing run:

| Field         | Value              | Where the run gets it                                                                                                           |
| ------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| repository    | `Avunu/docusystem` | the repository that runs the workflow                                                                                           |
| workflow file | `release.yml`      | the file name of the running workflow (this file; the publish step cannot move to another file)                                 |
| environment   | `npm`              | `environment: npm` of the `publish` job                                                                                         |
| permissions   | `publish`          | the step runs `npm publish`; npm documents `stage publish` (`--allow-stage-publish`) as a separate permission, not a substitute |

Look at the permissions line first if the placeholder was published through the staged flow (`npm stage publish`): a record created with `--allow-stage-publish` alone does not allow the direct publish that `release.yml` runs. The registry supports one record per package, so to correct it run `npm trust revoke @avunu/docusystem --id=<id>` with the id that `npm trust list` printed, then the `npm trust github` command of step 2.

**If the publish step fails with ENEEDAUTH.** At its default log level npm 11 reports a refused or skipped OIDC exchange only as `ENEEDAUTH ... This command requires you to be logged in to https://registry.npmjs.org/`. That one error covers a record that does not match, a record without the `publish` permission, and a job without `id-token: write`. The registry's reason is a verbose-level line, `npm verbose oidc Failed token exchange request with body message: ...`, so the publish step runs `npm publish` with `--loglevel verbose` (npm does not log the OIDC token or the exchanged token there, and GitHub masks `NPM_TOKEN`) and ends with an error annotation that points here. Read that line in the job log, correct the record on npmjs.com, then use "Re-run failed jobs" on the run: the tag and the GitHub Release already exist, and the step skips a version that npm already has.

## GitHub settings

State of `Avunu/docusystem` read on 2026-10-06, after the implementation pull requests were merged: public; auto-merge on; merge commits off, squash merging and rebase merging both on, with the squash message defaults "commit or pull request title" and "commit messages"; head branches deleted on merge; secret scanning, push protection, Dependabot security updates and private vulnerability reporting disabled; no rulesets, no environments and no protection on `main`; default workflow permission `read`; "Actions may create and approve pull requests" on (release-please needs it). None of the numbered settings below is in place yet.

1. **Settings, General, Pull Requests.** Allow squash merging only (turn rebase merging off; merge commits already are), with "Pull request title and description" as the default commit message (so that a `BREAKING CHANGE:` note in the body reaches the commit), and delete head branches on merge.
2. **Settings, Code security.** Enable Dependabot alerts and security updates, secret scanning with push protection, and **private vulnerability reporting** ([SECURITY.md](SECURITY.md) points at it).
3. **Settings, Rules, Rulesets, branch `main`.** Require a pull request, require the status check `ci` and no other, block force pushes and deletion.
4. **Settings, Rules, Rulesets, tags `v*.*.*`.** Restrict updates and deletions, so that a released tag can never move.
5. **Settings, General, Releases.** Turn on release immutability.
6. **Settings, Environments.** Create `npm` before the release pull request is merged, with "Deployment branches and tags" set to **Selected branches and tags** and one name pattern, `main`. It holds no secret once the first release is done.
   - If `npm` does not exist when the first `publish` job runs, GitHub creates it on the spot, with no protection rules and no branch restriction ("Running a workflow that references an environment that does not exist will create an environment with the referenced name"). The release still publishes, because the trusted publisher on npmjs.com matches the environment's name. What is lost is the restriction, so if that happens, open the new environment right after the run and add the rule.
   - Do not choose **Protected branches only**. GitHub describes it in terms of branch protection rules ("If no branch protection rules are defined for any branch in the repository, then all branches can deploy"), and `main` is protected here by a ruleset (step 3), so what the option would do is not known: it may restrict nothing, or it may reject the `publish` job before its first step. If a run is rejected that way, fix the environment and choose **Re-run failed jobs** on that run, never **Re-run all jobs**, which skips the publish.
7. **Settings, Actions, General.** Turn on "Require actions to be pinned to a full-length commit SHA" (every `uses:` in this repository already is). Leave the default workflow permission at `read`.

`node scripts/check-github-settings.mjs` reads all of these with the `gh` command line (logged in as an admin of the repository) and lists each one that is not in place, with what it is now and where to change it. It only reads, and a setting it is not allowed to see is reported as unknown, never as off. Run it before merging the release pull request, and again afterwards. The environment `npm` matters most for publishing: npm's trusted publisher checks the repository, the workflow file and the environment name but not the branch, so the environment's deployment-branch rule is what keeps a copy of `release.yml` edited on another branch from obtaining a publish token.

A public repository can call a reusable workflow only from a public repository, and a private repository can call a public one. A caller's organization needs "allow actions and reusable workflows" to include `Avunu/docusystem/*` if it restricts Actions to a list.

### Merging the release pull request

Use **Squash and merge**, and do not edit the title or the description of the pull request before merging it. release-please finds a merged release pull request by its `autorelease: pending` label, its branch name, its title and its body, never by the commit subject (`manifest.js` and `strategies/base.js` of release-please 17.x), so which commit a merge method writes does not matter to it, but an edited title or body does: it logs `Bad pull request title` or `Could not parse pull request body as a release PR`, creates no tag and no GitHub Release, and `build` and `publish` are skipped. The pull request then stays labelled `autorelease: pending`, and release-please refuses to open another release pull request ("There are untagged, merged release PRs outstanding") until someone fixes the label by hand.

Do not rebase-merge it. Squash is the one method this runbook has checked against that lookup; rebase merging has not been tried, and neither has whether GitHub accepts it for a pull request that carries "Update branch" merge commits.

## Domains of the documentation sites

Each adopting repository serves its site from `<label>.avunu.net`, with a `CNAME <label> -> avunu.github.io` in the `avunu.net` zone. Two things about those records are the maintainers' to keep safe, and neither can be a pull request.

### Verify avunu.net for the organization

A `CNAME` to `avunu.github.io` says nothing about who may serve the name. If a repository's Pages site is unpublished, renamed, archived or deleted while its record remains, any other GitHub account can add `<label>.avunu.net` as the custom domain of its own Pages site and serve content on a subdomain of `avunu.net`. Verifying the domain for the organization closes that: GitHub then lets only repositories of that organization use the domain and its immediate subdomains. It is a security control, not only a convenience, and it is in force whether or not decision 8 below is ever taken.

1. In the organization's settings (Settings, Code, planning, and automation, Pages), choose **Add a domain** and enter `avunu.net`. Only an organization owner can.
2. GitHub shows a TXT record. Create it in the `avunu.net` zone with the name `_github-pages-challenge-Avunu` (so `_github-pages-challenge-Avunu.avunu.net`) and the value GitHub gives. Wait for it to resolve, then choose **Verify**.
3. Do this once, before the first adopting repository gets its DNS record (the proof pilot of gate G4). It is checked in the organization's Pages settings, which list verified domains; no repository needs to repeat it.

The verification covers `avunu.net` and its immediate subdomains. A site on a deeper name such as `a.b.avunu.net` is not covered: verify that name itself too, or avoid it. `docusystem init` and `docusystem doctor` print the step with the project's values.

### Retire a site in this order

The record is what keeps the name pointing at GitHub, so it goes first. [Publishing](docs/guide/publishing.md#when-a-site-is-retired) is the same runbook for the people who own the repository.

1. Delete the `CNAME <label> -> avunu.github.io` record from the zone, or in the same change as the next steps.
2. Remove the custom domain in the repository's Pages settings (or unpublish Pages) and delete the `DOCS_SITE_ENABLED` variable.
3. Remove the `docs:` line from the project's avunu.net catalog entry.
4. Only then rename, archive or delete the repository. A rename changes the hyphenated domain that `init` derives: the old name is retired, the new one is a new site with its own record.

Sweep now and then: list the records of the zone that point at `avunu.github.io` and compare them with the repositories that have Pages enabled; a record without a repository is dangling and gets deleted.

## Gates

The order matters, because a thin shell needs a published package, a release tag and a lockfile that records the registry's integrity hash.

| Gate | Condition                                                                                                                                  | Who                                          |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| G1   | The implementation pull requests are merged to `main` and `ci` is green on `main`                                                          | A maintainer merges                          |
| G2   | The npm organization, placeholder, trusted publisher, GitHub settings and the `avunu.net` domain verification above are in place           | A maintainer                                 |
| G3   | The release pull request is merged, the tag `v0.1.0` exists and `@avunu/docusystem@0.1.0` is on npm with a verified provenance attestation | A maintainer merges; `release.yml` publishes |
| G4   | The proof pilot passes the GitHub checks in [Verified on GitHub](#verified-on-github)                                                      | An agent runs it, a maintainer merges        |
| G5   | The other pilots migrate, then the rest of the fleet, then the dogfood site                                                                | Agents; a maintainer merges                  |

The pilots are the first three repositories to adopt the system: `frappe-nix`, `erpnext_taskview` and `cloudflare-email-relay`. No pilot is changed until G3 holds. The proof pilot is `cloudflare-email-relay`, whose docs and workflows are the smallest.

### Launch order for the Projects menu

The project switcher of every docs site links to avunu.net, which has not relaunched yet. Read on 2026-10-06: `https://avunu.net/` answers 200 (the current site), but `https://avunu.net/projects.json` and `https://avunu.net/open-source/` answer 404, and so does the page of every bundled catalog entry that has no `docs` address (`https://avunu.net/open-source/<slug>/`: 25 of the 26 entries; the 26th, Jx, links to its own docs on jxsuite.com). A site enabled in that state works, but the browser's fetch of the live catalog fails quietly, the menu keeps the bundled list, and its links to avunu.net pages answer 404.

Nothing needs rebuilding when avunu.net relaunches: the bundled links are the final addresses (the 26 slugs of the catalog match the 26 project pages drafted for the relaunch), and each page swaps in the live catalog when idle. The order therefore only decides what the first visitors see:

1. **Relaunch avunu.net first.** It must serve `/projects.json` (version 1, with CORS headers, because the docs sites fetch it from their own origins) and `/open-source/<slug>/` for every catalog entry.
2. **Then enable each site.** Before setting `DOCS_SITE_ENABLED` on a repository, check `curl -fsSI https://avunu.net/projects.json` and `curl -fsSI https://avunu.net/open-source/<slug>/` for the repository's own slug. `docusystem init` and `docusystem doctor` print the condition next to the variable.
3. **Link the site last.** The README link and the `docs:` line of the avunu.net catalog entry come after the site is live, so that until then nothing sends a visitor to it.
4. **The proof pilot may go early.** Gate G4 needs a real deploy (row 2 of [Verified on GitHub](#verified-on-github)), so it cannot wait for the relaunch. Enable it and accept the dead menu: nothing links to its address yet. A maintainer may do the same for any other pilot.
5. **After the relaunch, take the refresh.** Until avunu.net publishes `projects.json`, `catalog.yml` treats the 404 as "no change". Once it does, the weekly run compares the live catalog with the bundled one and opens a pull request if they differ (for example when entries gain `docs:` addresses); merge it so that the next release carries it.

## Verified on GitHub

These GitHub behaviors have never been run. Confirm them on the proof pilot (gate G4) and record each result here in the pull request that confirms it. Until then the result is a placeholder.

| #   | Behavior to confirm                                                                                                                                                                                                                                                                                                                   | Result        | Date          | Evidence      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ------------- | ------------- |
| 1   | `docs.yml` starts and its `build` job passes on a Dependabot-authored `pull_request` (bump `@avunu/docusystem` in the pilot to trigger one) and on a pull request from a fork, with a read-only token and no secrets                                                                                                                  | [PLACEHOLDER] | [PLACEHOLDER] | [PLACEHOLDER] |
| 2   | On a push to the default branch, `docs-publish.yml` builds without deploying while `DOCS_SITE_ENABLED` is unset, then builds and deploys once it is `true`; `configure-pages` and `deploy-pages` work from `docs-deploy.yml`; the Pages artifact uploaded in the called build job is visible to the called deploy job of the same run | [PLACEHOLDER] | [PLACEHOLDER] | [PLACEHOLDER] |
| 3   | The path filter of `docs.yml` means `build / Check` is not reported on pull requests that touch no docs path, so it cannot be a required status as it stands (see open decision 7)                                                                                                                                                    | [PLACEHOLDER] | [PLACEHOLDER] | [PLACEHOLDER] |
| 4   | If `build / Check` is ever made required: a job skipped by `if` (a push to a non-default branch) counts as passing                                                                                                                                                                                                                    | [PLACEHOLDER] | [PLACEHOLDER] | [PLACEHOLDER] |
| 5   | The organization-level "allow actions and reusable workflows" policy permits `Avunu/docusystem/*`                                                                                                                                                                                                                                     | [PLACEHOLDER] | [PLACEHOLDER] | [PLACEHOLDER] |
| 6   | The release flow: release-please opens `chore: release v0.1.0`, the dispatched `ci` run attaches to its branch, merging tags `v0.1.0`, `build` hands its tarball to `publish` as an artifact (the one job with the OIDC token), and `publish` succeeds through OIDC with provenance                                                   | [PLACEHOLDER] | [PLACEHOLDER] | [PLACEHOLDER] |

Also not verified anywhere yet, and therefore gated: npm trusted publishing and provenance, macOS, release-please's behavior with this configuration, and the registry install of the published package. Windows is unsupported.

If row 2 fails because the deploy job cannot call a reusable workflow that asks for `pages: write` and `id-token: write`, the fallback is documented in [Workflows](docs/reference/workflows.md#if-a-called-deploy-job-is-rejected): only `docs-publish.yml` changes.

## Updating Jx and the catalog

The package pins the exact Jx versions it was tested with, so a Jx release reaches a documentation site in this order: Dependabot here (group `jx`, prefix `fix(deps)`) opens a pull request; `ci` builds everything against it, including the real-Jx canary, the consumer matrix and the browser suites; a person merges; release-please proposes a patch release; the fleet job runs on the release pull request; the release publishes; each site's own Dependabot opens a grouped pull request. `jx-latest.yml` installs the latest `@jxsuite/*` over the pins every week and opens an issue when the canary or the example build fails: that is the early warning for a Jx release that Dependabot has not proposed yet.

The project switcher's catalog is bundled. `catalog.yml` runs weekly, regenerates `site/data/projects.snapshot.json` with `npm run sync-catalog`, and when the file changed pushes a branch `fix/catalog-<date>` with the commit `fix(catalog): refresh the bundled project catalog`, opens a pull request and dispatches `ci.yml` on it. A release then carries the refresh. The script treats an HTTP 404 or an invalid document as "no change": the live `projects.json` of avunu.net is not published yet. "Invalid" includes text the compiler would act on: the contract refuses `${`, `<`, `>` and control characters in any string and a slug that is not a config slug, so a catalog that held one is never written. A catalog pull request whose diff nevertheless shows such text means the check was bypassed: do not merge it.

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
| 8   | One wildcard `*.avunu.net` `CNAME` to `avunu.github.io`, which would remove the per-repository DNS step. Only with the domain verification above, never without it | The per-repository flow, which works without it; the verification is done regardless                                 |                            |
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
