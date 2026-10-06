---
title: Documentation system
description: What @avunu/docusystem is, what a project keeps and gets from it, and where to read more.
order: 1
updated: 2026-10-06
tags: [overview, docs]
---

`@avunu/docusystem` is the documentation system shared by Avunu's open-source projects. A project writes its Markdown in `docs/`, adds a small `docs-site/` folder, and gets a documentation site with the look of avunu.net: a project switcher, search, light and dark themes, a sidebar, an "On this page" list, checked links and a GitHub Pages deployment.

Everything except the Markdown and a handful of facts about the project lives in one npm package: the layouts, components, design tokens, fonts, navigation, the Markdown and link checks, and the two reusable GitHub Actions workflows that check and publish the site.

## What a project keeps

```text
your-repo/
  docs/                              your Markdown (README.md is the home page)
  docs-site/
    docusystem.config.json           the seven facts about the project
    package.json                     one dependency: @avunu/docusystem
    .gitignore                       node_modules/, dist/, .docusystem/
    package-lock.json                committed; CI installs it frozen
  .github/
    workflows/docs.yml               pull requests: check the site
    workflows/docs-publish.yml       default branch: build and publish
    dependabot.yml                   keeps the package and the workflow pin current
```

The list is closed. A project that needs more has an [override](guide/overrides.md), not another file. The shell must not contain components, layouts, pages, fonts, scripts, tests, a `project.json`, a `data/` folder, a `docs.config.json`, a `bun.lock`, a committed `CNAME`, any `@jxsuite/*` dependency or an install script.

## What a project gets

- **A site that follows the package.** A new release arrives as one Dependabot pull request; nothing is copied between repositories.
- **Checks that fail the build.** In CI a broken link, a missing image, Markdown the site cannot show, a missing component or an empty link stops the build. See [Writing documentation](guide/writing-docs.md).
- **A site that is the same everywhere.** The project switcher lists the other Avunu projects, grouped by platform, and works offline from a catalog bundled in the package.
- **Customization with a visible cost.** Design tokens can be overridden in the config file and checked for contrast; any file can be replaced, and every replacement is printed on every build. See [Customizing](guide/overrides.md).
- **Nothing to run at install.** No install script runs, no network is used during a build (unless you ask for a fresh catalog), and the Jx packages are pinned exactly inside the package.

## How it works

`docusystem build` assembles a plain [Jx](https://jxsuite.com) project in `docs-site/.docusystem/site/` from real copies: the package's own `site/` folder, your overrides, a generated `project.json`, the resolved config, the catalog and your staged Markdown. It runs the pinned Jx compiler on that folder, post-processes the result, asserts what Jx would silently get wrong, and publishes it to `docs-site/dist`. Jx is an implementation detail: no project names a Jx package. The steps are listed in [Build pipeline](reference/build-pipeline.md).

> [!NOTE]
> Before this package, Avunu's first documentation sites copied a template folder into each repository. Where these pages mention "the earlier starter" they mean that template. `docusystem init` and `docusystem doctor` recognize what it leaves behind, and [Migrating from the earlier starter](guide/migrating-from-the-starter.md) moves a repository to the package.

## Requirements

| What                                           | Needs                                      |
| ---------------------------------------------- | ------------------------------------------ |
| `build`, `check`, `dev` and the other commands | Node 22.19.0 or newer, or Bun 1.4 or newer |
| Operating system                               | Linux or macOS; Windows is not supported   |
| `init` and `upgrade`                           | `git` on the `PATH`                        |
| The reusable workflows                         | A GitHub-hosted runner; nothing to install |

CI and deployments always use Node 24. Locally either runtime works; see [Versioning and compatibility](reference/versioning.md) for the tested matrix.

## Where to go next

- [Guide](guide/README.md): get started, write documentation, publish, customize, upgrade, troubleshoot.
- [Reference](reference/README.md): the config file, the command line, the build pipeline, the workflows, the doctor checks and the versioning policy.
- [Maintainers](maintainers/README.md): releasing the package and the changes asked of Jx.
