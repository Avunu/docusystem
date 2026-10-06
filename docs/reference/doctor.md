---
title: Doctor checks
description: Every check that docusystem doctor runs on a clone, grouped by area, with what is an error and what is a warning.
order: 3
updated: 2026-10-06
tags: [reference, doctor, checklist]
---

`docusystem doctor` is the maintainer checklist as far as a clone of the repository shows it. It works offline: nothing touches the network. Each finding is `ok`, `warning` or `error`, and any error makes the exit code 1; warnings alone exit 0. `--json` prints the findings as JSON.

After the checks it prints the GitHub and DNS values a maintainer still has to set, from the config: the Pages source, the domain verification for the organization, the custom domain, the DNS record, the repository variable `DOCS_SITE_ENABLED`, branch protection and the `docs:` line of the avunu.net catalog entry, and what to delete when the site is retired. Those need a person with access, so `doctor` cannot check them. See [Publishing](../guide/publishing.md#what-a-maintainer-sets-once).

Run it after `init`, after every upgrade, and when a Dependabot pull request for the docs site looks odd.

## Config

Errors:

- The config is invalid according to the schema.
- The slug is spelled differently from a catalog key.

Warnings:

- The slug is not in the bundled catalog.

## Docs

Errors:

- The home page is missing (`README.md`, `readme.md` or `index.md` in the docs folder).

## Workflows

Errors:

- `docs.yml` or `docs-publish.yml` is missing, or does not call the reusable workflows.
- A `uses:` line is not a 40-character hexadecimal commit. Tags and branches are refused.
- The pinned version is of a different major than the installed package.
- `pull_request_target` or `workflow_run` appears anywhere in them.
- `docs.yml` grants any write permission.
- `docs-publish.yml` lacks the `vars.DOCS_SITE_ENABLED` gate, or the `pages: write` and `id-token: write` permissions on the deploy job.
- `site-directory` or the `paths` globs disagree with the config.

Warnings:

- A pin has no `# vX.Y.Z` comment.
- The pinned minor or patch differs from the installed package. That is fine within a major; `docusystem upgrade` aligns them.
- A literal branch name appears in a caller.

## Dependabot

All warnings:

- There is no npm entry for the site folder.
- There is no `github-actions` entry.
- An entry is for the wrong ecosystem for the lockfile.
- The npm entry for the site folder has a cooldown that does not exclude `@avunu/docusystem`: a release of the package would wait for it. `init` adds the exclusion when it converts a `bun` entry, and prints the lines to add for an npm entry that was already there.
- A `github-actions` entry has a cooldown that does not exclude `Avunu/docusystem`: a release of the shared workflows would wait for it.

The file is parsed, not searched: an `npm /` entry followed by a `bun /docs-site` entry is not a match for an npm entry for the site folder.

## Auto-merge

Errors:

- An auto-merge workflow lacks an exclusion for exactly `dependabot/npm_and_yarn/<site folder>`. A `dependabot/bun/...` exclusion counts as missing, because the shell's lockfile makes Dependabot's ecosystem `npm`. The message says that `docusystem init` fixes it only when `init` can patch that workflow; otherwise it says what to do by hand, with the finished `if:` line.
- An auto-merge workflow lacks an exclusion for the `github-actions` pull requests (`!startsWith(github.head_ref, 'dependabot/github_actions/')`, or a negated `dependency-names` test of `Avunu/docusystem`): the pull request that moves the pin of the shared workflows would merge by itself, and a merge publishes the site with the new workflow code.

## Lockfile

Errors:

- `bun.lock` or `bun.lockb` is present.
- No lockfile is present.
- `bun.lock` and `package-lock.json` are both present.

## Overrides

Errors:

- An ejected file that the installed package no longer ships (`stale`).

Warnings:

- An override whose package file changed since `eject` ("copied from X, package file changed", `changed`).
- An override that replaces a package file but was made without `eject`, so it cannot be drift-checked (`not ejected`).

An override that is `current` is reported as `ok`.

## Repository

All warnings:

- A `.pre-commit-config.yaml` with a copyright hook (exclude `^docs/` from it).
- Leftovers of the earlier starter in the site folder: `components/`, `layouts/`, `pages/`, `project.json` or `scripts/`.

Formatter configurations that would reformat `docs/` are only mentioned.
