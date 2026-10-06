---
title: Migrating from the earlier starter
description: How to move a repository that copied the starter's docs-site/ folder to @avunu/docusystem, what init carries over, what to delete by hand and how to check the result.
order: 7
updated: 2026-10-06
tags: [guide, migration, starter, init]
---

Before this package, Avunu's first documentation sites copied a template folder into each repository: a `docs-site/` with about 80 files (components, layouts, pages, scripts, fonts, a `project.json`, a Bun lockfile) and a 121-line workflow that built the site. This page moves such a repository to `@avunu/docusystem`. Your Markdown in `docs/` does not change.

The whole move is one pull request: delete what the package now supplies, run `init`, run `npm install`.

## What changes

| The starter                                                                                    | After the move                                                                            |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `docs-site/` with `components/`, `layouts/`, `pages/`, `scripts/`, `data/`, `public/` and more | `docs-site/` with `docusystem.config.json`, `package.json`, `.gitignore` and the lockfile |
| `docs.config.json`                                                                             | `docusystem.config.json`: the same keys, and `init` copies the values                     |
| A committed `public/CNAME`                                                                     | Generated from `domain` on every build                                                    |
| `project.json`, edited by hand                                                                 | Generated; changes go in `theme` (or `jx`) in the config                                  |
| Bun, `bun.lock`, a `postinstall` script and `engines.bun`                                      | npm and `package-lock.json`; no install script                                            |
| A 121-line `docs.yml` that builds the site                                                     | `docs.yml` and `docs-publish.yml`, which call the shared workflows pinned to a commit     |
| A `bun` Dependabot entry for `/docs-site`                                                      | An `npm` entry                                                                            |
| `dependabot/bun/docs-site` excluded from auto-merge                                            | `dependabot/npm_and_yarn/docs-site`                                                       |

When the domain stays the same, nothing outside the repository changes: the GitHub Pages settings, the DNS record, the `DOCS_SITE_ENABLED` variable, branch protection and the avunu.net catalog entry stay as they are.

## Before you start

You need Node 22.19.0 or newer, `git`, and a clone whose `origin` remote points at GitHub. Work on a branch.

Keep `docs-site/docs.config.json` until `init` has run. It is where the project's name, tagline and **domain** are written down. `init` reads it, so a site that is already published keeps its address. Without it, `init` infers the values from the repository name and the avunu.net catalog, and the inferred domain can differ from the published one: a site published at `cloudflare-email.avunu.net` from a repository named `cloudflare-email-relay` would be moved to `cloudflare-email-relay.avunu.net`.

> [!TIP]
> If you already deleted `docs-site/`, the old values are still in git: `git show HEAD:docs-site/docs.config.json`. Pass them to `init` with `--name`, `--tagline`, `--domain` and the other options listed in [Getting started](getting-started.md#what-init-does). Everything `init` chooses by itself is printed under "chosen for you", so check that list against the old file.

If you changed any of the starter's files (a color, a component, a page), read [If you changed starter files](#if-you-changed-starter-files) before deleting them.

## The steps

Run these at the repository root.

1. **Start a branch.**

   ```bash
   git switch -c docs/use-docusystem
   ```

2. **Delete what the package supplies.** Keep `docs.config.json`, `package.json` and `.gitignore`: `init` reads or rewrites them.

   ```bash
   git rm -r --ignore-unmatch docs-site/components docs-site/layouts docs-site/pages \
     docs-site/scripts docs-site/data docs-site/public docs-site/project.json \
     docs-site/README.md docs-site/bun.lock docs-site/bun.lockb
   ```

   If `git` refuses a file because it has changes, you changed a starter file on purpose. If `public/` holds files of your own (a logo, an og image), leave `docs-site/public` out of the command and delete only the starter's copies. See [If you changed starter files](#if-you-changed-starter-files).

3. **Run `init` with `--force`.**

   ```bash
   npx @avunu/docusystem init --force
   ```

   `--force` is needed because `init` never overwrites a workflow or a `package.json` that is not its own, and the starter's are not. Read what it would do first with `--dry-run`. `init` does this:

   - Writes `docs-site/docusystem.config.json` from `docs.config.json`: name, tagline, slug, platform, repo, **domain**, license and branch are kept as they are. The template's placeholder values (a name of "Project Name", the "One sentence that says..." tagline) are not values and are inferred instead. Anything it has to infer is printed under "chosen for you".
   - Rewrites `docs-site/package.json` to the one dependency and the three scripts, drops the Jx dependencies, the `postinstall` script and `engines.bun`, and keeps its other fields.
   - Replaces `.github/workflows/docs.yml` with the caller of the shared workflow, adds `docs-publish.yml`, and pins both to the commit of the tag `v<installed version>`. Pass `--workflow-sha <COMMIT_SHA>` when that commit cannot be looked up (offline).
   - Converts the `bun` Dependabot entry for `/docs-site` to `npm`, and the `dependabot/bun/docs-site` exclusion of an auto-merge workflow to `dependabot/npm_and_yarn/docs-site`.
   - Lists every starter file that is still in `docs-site/`. It deletes nothing it did not write. When step 2 was complete, the list holds only `docs.config.json`, which step 4 deletes.

   To change the address while you are at it, pass `--domain <DOMAIN>`. Then the Pages custom domain and the DNS record change too: see [Publishing](publishing.md).

4. **Delete the old configuration file** once `docusystem.config.json` has the values you expect.

   ```bash
   git rm docs-site/docs.config.json
   ```

5. **Install and check.**

   ```bash
   cd docs-site
   npm install
   npm run check
   npx docusystem doctor
   ```

   `npm install` writes `package-lock.json`, which replaces `bun.lock`. Commit it: CI installs it frozen. `check` is the strict build, the contrast gate and the link crawl. The document rules are the starter's, carried over, so Markdown that passed before should pass now. `doctor` must end with no errors. A warning that names a leftover tells you which step 2 file was missed.

6. **Commit and open the pull request.** In rehearsals on the three pilot repositories the change was 87 or 88 files: about 12,600 lines removed and about 3,550 added, of which about 3,500 are the lockfile. The lines you author are the config, `package.json`, `.gitignore` and the two workflows.

## If you changed starter files

The package supplies the same files, so a change you made has to go somewhere that survives an upgrade. Use the cheapest place that works. The ladder is in [Customizing](overrides.md).

| You changed                                           | Move it to                                                                                                                                                                                                                  |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Colors or other design tokens in `project.json`       | `theme.light` and `theme.dark` in `docusystem.config.json`. Unknown tokens are errors, and `check` re-runs the contrast gate.                                                                                               |
| A component, layout or page                           | `docusystem eject components/<file>` (or `layouts/`, `pages/`) copies the package's file into `overrides/`; apply your change there. It is printed on every build and reported by `doctor` when the package's file changes. |
| Another setting of `project.json`                     | The `jx` fragment of the config, as a last resort. It is outside semver.                                                                                                                                                    |
| Extra static files in `public/` (a logo, an og image) | Keep them in `docs-site/public/`. Delete only the starter's copies of the fonts, brand marks and favicon, and `public/CNAME`. `check` counts the copies.                                                                    |
| Your own scripts in `scripts/`                        | There is no place for them in the shell. Run them from the repository, outside `docs-site/`.                                                                                                                                |

Copy a file out before you delete its folder, then `eject` the package's version and re-apply the change to that.

## Around the repository

`init` does not touch these. `doctor` prints the ones it can see.

- **Formatter and hook excludes.** Excludes for `docs-site/` that only existed because of the starter's code (for example in `.pre-commit-config.yaml`, `.oxfmtrc.json` or `.oxlintrc.json`) can go. Keep any exclusion for `docs/`: a hook that stamps a copyright comment above the front matter should skip it.
- **Dependabot cooldowns.** If the repository's Dependabot entries have a `cooldown`, `doctor` asks you to add `@avunu/docusystem` (npm entry) and `Avunu/docusystem` (github-actions entry) under `cooldown.exclude`, so that releases of the package and of the shared workflows are not held back.
- **A second workflow.** Delete any other workflow that builds or installs `docs-site/` with Bun.
- **The README.** Link the documentation if it does not already.

## If something goes wrong

Nothing leaves your machine until you push the branch, so you can switch back and start over. The messages you are most likely to meet:

- `init` refuses a file: it names the file and says what to pass. With `--force`, read `--dry-run` first.
- `check` warns `public/ in the site folder holds N files identical to the package's own`: delete `docs-site/public/`, or keep only the files you added.
- `assemble: public/CNAME is not allowed`: delete `docs-site/public/CNAME`. The file is generated from `domain`.
- `doctor` errors on `bun.lock`: delete it and run `npm install`.

More messages are in [Troubleshooting](troubleshooting.md).
