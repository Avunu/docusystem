---
title: Workflows
description: The two reusable GitHub Actions workflows, docs-build.yml and docs-deploy.yml, with their inputs, permissions, steps and the trust model.
order: 5
updated: 2026-10-06
tags: [reference, github-actions, security]
---

Two reusable workflows live in `Avunu/docusystem/.github/workflows/`. A project calls them from its own `docs.yml` and `docs-publish.yml` with:

```text
uses: Avunu/docusystem/.github/workflows/<file>@<40-hex commit> # vX.Y.Z
```

The caller pins a commit, never a tag or a branch, and puts the version in the trailing comment. There is no moving major tag. Callers' triggers must be `pull_request`, `push` or `workflow_dispatch`, never `pull_request_target` or `workflow_run`, because the build workflow checks out and executes the pull request's code. `docusystem doctor` errors on both.

The setup a maintainer does once is in [Publishing](../guide/publishing.md).

## `docs-build.yml`

| Item                   | Value                                                                                                                                                                               |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Input `site-directory` | String, default `docs-site`. Validated against `^[A-Za-z0-9_][A-Za-z0-9._/-]*$` with no `..`, and passed to shell steps only through the environment.                               |
| Input `pages-artifact` | Boolean, default `false`. `true` uploads the Pages artifact (with hidden files) for `docs-deploy.yml`; otherwise a 7-day review artifact named `docs-site`.                         |
| Outputs, secrets       | None                                                                                                                                                                                |
| Job                    | Id `check`, name `Check`. From a caller job named `build` the required-check name is `build / Check`. On a push it runs only for the default branch. Permissions: `contents: read`. |
| Environment            | `DOCUSYSTEM_WORKFLOW_CONTRACT: "1"` and `DOCUSYSTEM_BRANCH`, the repository's default branch                                                                                        |

Steps:

1. Validate the site directory.
2. Check out the repository with `persist-credentials: false`.
3. Require `package-lock.json` and refuse `bun.lock` and `bun.lockb`.
4. Set up Node 24 with `package-manager-cache: false`.
5. `npm ci --ignore-scripts --no-audit --no-fund`.
6. `npm audit signatures`, plus an assertion that `@avunu/docusystem` has a verified provenance attestation.
7. `CI=true ./node_modules/.bin/docusystem check --ci`: the installed CLI, never `npx` or `bunx`.
8. Upload the site: the review artifact on a pull request or when `pages-artifact` is false, else the Pages artifact.
9. On failure, upload `.docusystem/manifest.json`, `.docusystem/jx.log` and `.docusystem/site` (without `node_modules`) as the artifact `docusystem-debug`.

## `docs-deploy.yml`

| Item              | Value                                                                                                                                                                                                                                          |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inputs, secrets   | None                                                                                                                                                                                                                                           |
| Output `page-url` | The Pages URL                                                                                                                                                                                                                                  |
| Job               | Id `deploy`, name `Publish`. Runs only for events other than `pull_request`, on the default branch. Permissions: `pages: write` and `id-token: write`. Concurrency group `pages` with `cancel-in-progress: false`. Environment `github-pages`. |
| Steps             | `configure-pages`, then `deploy-pages`                                                                                                                                                                                                         |

It downloads the Pages artifact that `docs-build.yml` made in the same run and publishes it. It executes no project code. Every action in both workflows is pinned to a commit SHA.

## Permissions

A called workflow cannot widen its caller's permissions, so the caller grants them:

- `docs.yml` (pull requests) calls only `docs-build.yml` and grants only `contents: read`.
- `docs-publish.yml` grants `contents: read` to the build job, and `pages: write` and `id-token: write` to the deploy job. It is the only file that grants write permissions.
- Every caller starts with `permissions: {}`.

No workflow that a pull request can trigger asks for `pages: write` or `id-token: write`. That is why the system has two caller files, and why the reusable side is split the same way: it is not verified that a called workflow which asks for those permissions starts on a Dependabot-authored pull request, and Dependabot's upgrade pull requests are the main upgrade path.

## Trust model

A pull request can change `docs/` and `docs-site/`: the config, the lockfile and any override. An override's component JSON can carry compiler-time function bodies that run at build time, so a pull request can therefore run code in the build job. That job has a read-only token and no secrets.

A pull request cannot:

- change the reusable workflows, which are pinned by commit;
- reach the deploy job, which is in a file that no pull request triggers;
- publish anything.

`${...}` in Markdown is inert under the pinned parser, and the escaping of page titles and headings is kept.

## If a called deploy job is rejected

The one thing that could not be tested before the first real run is whether the `deploy` job of `docs-publish.yml` can call `docs-deploy.yml` with `pages: write` and `id-token: write`. If GitHub rejects it, the only change is in `docs-publish.yml`: replace the job that has `uses:` by a job with the same `permissions`, `needs` and `if`, whose two steps are the SHA-pinned `configure-pages` and `deploy-pages` actions copied from `docs-deploy.yml`. The build side and the package do not change. This shape is documented, not shipped.

## The workflow contract

`docs-build.yml` sets `DOCUSYSTEM_WORKFLOW_CONTRACT: "1"`. The CLI compares it with the integer `WORKFLOW_CONTRACT` it implements and exits 3 on a mismatch, naming the `uses:` line to change. The contract changes only when the workflows and the CLI stop being able to work together: the command the workflow runs (`docusystem check --ci` from the site folder), the environment it sets, or the output path `<site>/dist`. See [Versioning](versioning.md#workflow-contract).
