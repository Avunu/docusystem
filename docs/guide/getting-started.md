---
title: Getting started
description: Add the documentation site to a repository in three commands, check it, preview it and commit it.
order: 1
updated: 2026-10-06
tags: [guide, init, quick-start]
---

This page takes a repository with Markdown (or only a README) to a checked documentation site. It ends with the steps that only a maintainer can do in GitHub and DNS, which a pull request cannot.

## Before you start

You need Node 22.19.0 or newer (or Bun 1.4 or newer), `git`, and a clone of the repository whose `origin` remote points at GitHub. The command infers most values from that remote and from the Avunu project catalog, so run it in the clone, not in a copy of the files.

## The three commands

From the repository root:

```bash
npx @avunu/docusystem init --from-readme
cd docs-site && npm install
npm run check
```

1. `init` writes the shell (see below). `--from-readme` copies the repository's `README.md` to `docs/README.md` when `docs/` has no `README.md` or `index.md` yet; it never overwrites and never moves the original.
2. `npm install` creates `package-lock.json`. Commit it: CI installs with the lockfile frozen.
3. `npm run check` is what CI runs: a strict build, the colour-contrast gate and a crawl of every link. The site is written to `docs-site/dist/`.

To see the site while you work, run `npm run dev` in `docs-site/`. It builds once, serves what would be deployed on `127.0.0.1:3000` the way GitHub Pages will (trailing slashes, `404.html`), and rebuilds and reloads the browser when the Markdown, the config, `overrides/` or `public/` change. Use `--port <n>` when port 3000 is taken: `npm run dev -- --port 3417`.

> [!TIP]
> The first `check` on a repository whose README was written for GitHub usually finds things the site cannot render. Run `npm run build -- --lenient` first: it lists every document problem as a warning and still builds. Fix them, then run `check`, which is always strict.

## What `init` does

`init` works at the repository root or inside the site folder. It never creates `docs-site/docs-site`, and from any other subfolder it stops and says where to run it.

It infers, in order:

1. The repository from the `origin` remote (ssh and https forms are normalized to `https://github.com/<owner>/<name>`).
2. The entry of the Avunu project catalog whose `repo` matches. If several match and none is named like the repository, it asks for `--slug`.
3. From that entry: `slug`, `name` (the catalog title), `tagline` (the catalog summary), `platform` (else `general`) and `license`. The `domain` is the slug with `_` written as `-`, plus `.avunu.net`.

Everything it chose is printed under "chosen for you". A value it cannot infer is an error that names the option to pass: `--name`, `--tagline`, `--license`. Values already in an existing `docusystem.config.json` win over inference, so running `init` again never resets a tagline.

It writes these files (the same list as the [overview](../README.md#what-a-project-keeps)):

| File                                          | Purpose                                                                                                                                      |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs-site/docusystem.config.json`            | The seven identity keys. See the [config reference](../reference/configuration.md).                                                          |
| `docs-site/package.json`                      | One dependency, `@avunu/docusystem`, and the scripts `dev`, `build` and `check`.                                                             |
| `docs-site/.gitignore`                        | `node_modules/`, `dist/` and `.docusystem/`.                                                                                                 |
| `.github/workflows/docs.yml`                  | Checks the site on every pull request that touches the docs.                                                                                 |
| `.github/workflows/docs-publish.yml`          | Builds on the default branch and publishes once the site is enabled.                                                                         |
| `.github/dependabot.yml`                      | An npm entry for the site folder, plus a `github-actions` entry if the repository has none. An existing file is appended to, never replaced. |
| `.github/workflows/dependabot-auto-merge.yml` | Only if the repository has one: a one-line patch that keeps pull requests for the docs site out of auto-merge.                               |

Both workflows pin the shared workflows to the commit of the tag `v<installed version>`, found with `git ls-remote`. If that cannot be resolved (offline, or the tag does not exist) `init` exits 1 and names `--workflow-sha`; it never falls back to a tag.

Useful options:

| Option                                                     | Effect                                                                                                     |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `--dry-run`                                                | Prints every file and diff, writes nothing.                                                                |
| `--site-dir <dir>`                                         | Uses another folder than `docs-site`, relative to the repository root.                                     |
| `--docs <path>`                                            | Sets the Markdown folder, relative to the site folder (default `../docs`).                                 |
| `--no-workflow`, `--no-dependabot`, `--no-patch-automerge` | Skips that part.                                                                                           |
| `--force`                                                  | Overwrites a differing workflow, or rewrites an existing `package.json`'s dependencies to the one package. |

`init` refuses to overwrite a workflow that differs from its own scaffold (a workflow copied from the earlier starter counts) and refuses a `package.json` that has a `postinstall` script or any `@jxsuite/*` dependency, because that is a sign of the earlier copy-the-template starter. Pass `--force` once you have read what it would replace. Run `docusystem init --help` for the whole option list.

## Check the result

```bash
npx docusystem doctor
```

Still in `docs-site/`, this runs the maintainer checklist as far as a clone can show it, offline: the config, the workflows, Dependabot, the lockfile and overrides. It also prints the GitHub and DNS settings still to be made, with the exact values for this project. The [doctor reference](../reference/doctor.md) lists every check.

## What a maintainer still has to do

Once per repository, none of it possible from a pull request; `init` and `doctor` print the same list with your values filled in:

1. GitHub Pages source: GitHub Actions.
2. The domain `avunu.net` verified for the GitHub organization, once and before any DNS record, so that no other account can claim the subdomain if the site is ever unpublished while its record remains.
3. The custom domain, with Enforce HTTPS once the certificate exists.
4. DNS: a `CNAME` from the domain's first label to `avunu.github.io` (DNS only until the certificate exists).
5. The repository variable `DOCS_SITE_ENABLED` set to `true`.
6. Branch protection on the default branch, because every push to it publishes.
7. A `docs: https://<domain>` line in the project's avunu.net catalog entry.

The details, and why each one is needed, are in [Publishing](publishing.md). When a site is retired, delete its `CNAME` first: see [When a site is retired](publishing.md#when-a-site-is-retired).

## Humans keep a few things

- The README's link to the documentation.
- Formatter and hook exclusions that cover `docs/`. A pre-commit hook that stamps a copyright comment above front matter should exclude `^docs/`: staging repairs the stamp for the site, but GitHub and Obsidian read the unrepaired file and then show the front matter as text.
