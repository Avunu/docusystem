---
title: Publishing
description: What the two caller workflows do, what a maintainer sets once in GitHub and DNS, and how Dependabot keeps the site current.
order: 3
updated: 2026-10-06
tags: [guide, github-actions, github-pages]
---

A project publishes its site with two small workflow files that call shared workflows in this repository, `Avunu/docusystem`. This page explains what they do and what a maintainer has to switch on. The complete inputs, permissions and steps of the shared workflows are in the [workflow reference](../reference/workflows.md).

## The two callers

`init` writes both files, shown here for a repository whose docs are in `docs/` and whose site folder is `docs-site/`. In each `uses:` line `<COMMIT_SHA>` stands for the 40-character commit of the tag `v<installed version>`, and the comment after it names that version.

`.github/workflows/docs.yml` checks the site on every pull request that touches the docs. Its token is read-only, so nothing in it can publish:

<!-- prettier-ignore -->
```yaml
name: Docs

# Checks the documentation on every pull request that touches it. The work is done by the shared
# workflow of Avunu/docusystem, pinned to a commit (Dependabot's github-actions entry moves the pin).
# Nothing here can publish: the token is read-only. Publishing is docs-publish.yml.
on:
  pull_request:
    paths: ["docs/**", "docs-site/**", ".github/workflows/docs.yml", ".github/workflows/docs-publish.yml"]

permissions: {}

concurrency:
  group: docs-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  build:
    permissions:
      contents: read # checkout
    uses: Avunu/docusystem/.github/workflows/docs-build.yml@<COMMIT_SHA> # v<VERSION>
    with:
      site-directory: docs-site
```

`.github/workflows/docs-publish.yml` builds the default branch and publishes it once the site is enabled. It runs on a push and by hand, never on a pull request, so it never sees a pull request's token:

<!-- prettier-ignore -->
```yaml
name: Docs publish

# Builds the documentation on the default branch and publishes it to GitHub Pages once a maintainer
# has set the repository variable DOCS_SITE_ENABLED to true (until then it only builds and checks).
# Runs on push and by hand, never on a pull request, so it never sees a pull request's token.
on:
  push:
    paths: ["docs/**", "docs-site/**", ".github/workflows/docs.yml", ".github/workflows/docs-publish.yml"]
  workflow_dispatch:

permissions: {}

jobs:
  build:
    permissions:
      contents: read # checkout
    uses: Avunu/docusystem/.github/workflows/docs-build.yml@<COMMIT_SHA> # v<VERSION>
    with:
      site-directory: docs-site
      pages-artifact: ${{ vars.DOCS_SITE_ENABLED == 'true' }}

  deploy:
    needs: build
    if: ${{ vars.DOCS_SITE_ENABLED == 'true' }}
    permissions:
      pages: write # publish the artifact
      id-token: write # prove to Pages that this run made it
    uses: Avunu/docusystem/.github/workflows/docs-deploy.yml@<COMMIT_SHA> # v<VERSION>
```

The `paths` globs and `site-directory` follow the config: the docs folder relative to the repository root, and the site folder. Some facts about these files:

- **Neither names a branch.** The shared workflows read the repository's default branch themselves, so a repository whose default branch is `develop` or `18.0` needs nothing, and a rename of the default branch needs no edit.
- **The build runs on every pull request, even before Pages is enabled.** Only the deploy job waits for `DOCS_SITE_ENABLED`.
- **A push to another branch** that touches these paths starts a run whose jobs are skipped.
- **A commit, never a tag.** Callers pin a commit with a `# vX.Y.Z` comment. There is no moving major tag. `docusystem upgrade` re-pins both files, and Dependabot's `github-actions` entry moves the pin.

## What a maintainer sets, once

None of this can be done by a pull request. `docusystem init` prints it with your values, and `docusystem doctor` prints it again from the config.

1. **Pages source.** Repository settings, Pages, Build and deployment, Source: **GitHub Actions**.
2. **Verify the domain, once for the organization.** Organization settings, Pages, Add a domain: `avunu.net`, and add the TXT record `_github-pages-challenge-Avunu.avunu.net` that GitHub shows. This is a security measure, not a convenience: it covers every immediate subdomain, so no other GitHub account can claim `<label>.avunu.net` (see [When a site is retired](#when-a-site-is-retired)). Do it before the first DNS record below; it is not repeated per repository.
3. **Custom domain.** Repository settings, Pages, Custom domain: the `domain` of `docusystem.config.json`. It is the repository name with hyphens, never the slug's underscores. Tick **Enforce HTTPS** once GitHub has issued the certificate.
4. **DNS.** Add `CNAME <label> -> avunu.github.io`, where `<label>` is the domain's first label. Keep it DNS only (no proxy) until the certificate exists.
5. **Enable the site.** Set the repository variable `DOCS_SITE_ENABLED` to `true` (Settings, Secrets and variables, Actions, Variables), or:

   ```bash
   gh variable set DOCS_SITE_ENABLED --body true --repo <OWNER>/<REPO>
   ```

   Until it is set, `docs-publish.yml` only builds and checks.

   Set it after avunu.net has relaunched. The Projects menu lists the projects of avunu.net's catalog and links each one to its docs site or, when it has none, to its page `https://avunu.net/open-source/<slug>/`. Until avunu.net serves `https://avunu.net/projects.json` and those pages, the browser's fetch of the live catalog fails quietly, the menu keeps the list bundled in the package, and its links to avunu.net pages answer 404. Nothing else is affected, and nothing needs rebuilding afterwards: the links start to work when avunu.net publishes the pages. Enabling the site earlier means accepting a dead menu; [Launch order for the Projects menu](../../MAINTAINING.md#launch-order-for-the-projects-menu) says when that is reasonable.

6. **Protect the default branch.** Every push to it publishes. Require a pull request and the repository's own CI check, so that nothing reaches the site without a review.
7. **List the site in the catalog.** In avunu.net's catalog entry for the project, set `docs: https://<domain>`. The project switcher of every docs site then links to it.

## When a site is retired

The CNAME of step 4 keeps pointing `<label>.avunu.net` at GitHub for as long as it exists, whatever the repository does. If the repository's Pages site is unpublished, or the repository is renamed (the domain is derived from the name), archived or deleted, while the record remains, the name is dangling: with no verified domain, another GitHub account can add `<label>.avunu.net` as the custom domain of its own Pages site and serve its own content on a subdomain of `avunu.net`. The verification of step 2 prevents that, and the order below removes the cause:

1. Delete the `CNAME <label> -> avunu.github.io` record first, or in the same change.
2. Remove the custom domain in the repository's Pages settings, or unpublish Pages, and delete the `DOCS_SITE_ENABLED` variable.
3. Remove the `docs:` line from the project's avunu.net catalog entry, so that the project switcher stops linking to a site that is gone.
4. Only then rename, archive or delete the repository.

When a rename changes the domain, treat the old name as retired and the new one as a new site: it needs its own record, and the old record needs deleting.

## Dependabot

`init` appends this npm entry for the site folder to the `updates:` list of `.github/dependabot.yml` (creating the file with `version: 2` if it does not exist, and never replacing one). It appends a `github-actions` entry for `/` only if the repository has none, because Dependabot rejects two entries for one ecosystem and directory:

```yaml
updates:
  # The documentation site (docs-site/): @avunu/docusystem and the packages it brings. A person reviews
  # these pull requests: a merge to the default branch publishes the site (see the auto-merge workflow, if any).
  - package-ecosystem: npm
    directory: /docs-site
    schedule:
      interval: weekly
    cooldown:
      default-days: 7
      exclude:
        - "@avunu/docusystem"
    groups:
      docs-site-packages:
        patterns: ["*"]
    commit-message:
      prefix: chore
```

A new release of the package arrives as one grouped npm pull request, and a new commit pin as one `github-actions` pull request. The cooldown delays updates of third-party packages; `@avunu/docusystem` and `Avunu/docusystem` are excluded from it so that their releases arrive at once. If an existing `github-actions` entry has a cooldown that does not exclude `Avunu/docusystem`, `docusystem doctor` warns.

Both pull requests run `docs.yml` and upload the built site as a review artifact. **A person merges them**, because a merge to the default branch publishes the site. For that reason `init` patches an existing `dependabot-auto-merge.yml` to leave the site's pull requests out:

<!-- prettier-ignore -->
```yaml
    # The documentation site's package updates (docs-site/) are reviewed by a person: a merge to the
    # default branch publishes the site.
    if: ${{ github.actor == 'dependabot[bot]' && !startsWith(github.head_ref, 'dependabot/npm_and_yarn/docs-site') }}
```

The branch prefix says `npm_and_yarn` because the shell's lockfile is `package-lock.json`, which makes Dependabot's ecosystem `npm`. A `dependabot/bun/docs-site` exclusion, as the first sites to adopt the system had, is rewritten to this one; any other shape is left alone, printed with the line to add. `doctor` reports an auto-merge workflow that lacks the exclusion.

> [!NOTE]
> The `docs.yml` path filter means its check is not reported on pull requests that touch no docs path, so it cannot be a required status check as it stands. Whether to make it always report, so that the exclusion can go, is an open decision of the maintainers; see [MAINTAINING.md](../../MAINTAINING.md).

## What the workflows do

The build job installs the site's locked dependencies without running their scripts, verifies the registry signatures and the provenance of `@avunu/docusystem`, then runs the installed CLI: `docusystem check --ci`. A pull request's job has a read-only token and no secrets. The deploy job runs no project code: it hands the Pages artifact that the build job made in the same run to GitHub Pages.

A pull request can change `docs/` and `docs-site/` (the config, the lockfile and any override) and therefore run code in the build job. It cannot change the shared workflows, which are pinned by commit, and it cannot reach the deploy job, which lives in a file that no pull request triggers. The [workflow reference](../reference/workflows.md#trust-model) states the model in full.

When a build fails, the job uploads `.docusystem/manifest.json`, `.docusystem/jx.log` and the assembled project as the artifact `docusystem-debug`, so that a red run can be read without a checkout.
