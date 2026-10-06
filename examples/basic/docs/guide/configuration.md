---
title: Configuration
description: The few facts about a project that the site needs.
order: 4
updated: 2026-10-06
tags: [reference]
---

# Configuration

A site is described by one file, `docs-site/docusystem.config.json`. Seven keys are required; everything else about the site (its address, the `CNAME` file, the package name, the edit link) is derived from them.

| Key        | Meaning                                                        |
| ---------- | -------------------------------------------------------------- |
| `name`     | The display name of the project.                               |
| `tagline`  | One sentence about the project, shown on the landing page.     |
| `slug`     | The project's key in the avunu.net catalog.                    |
| `platform` | `frappe`, `odoo`, `wordpress`, `nixos` or `general`.           |
| `repo`     | The GitHub repository, as `https://github.com/<owner>/<name>`. |
| `domain`   | The custom domain, without a scheme.                           |
| `license`  | The project's license.                                         |

The optional keys are `branch`, `docs`, `theme`, `images` and `jx`.

> [!IMPORTANT]
> The default branch is detected (from the workflow's environment, then from the `origin` remote), so `init` writes `branch` only when it is given `--branch`.

Read this example's [config file](../../docs-site/docusystem.config.json) and the [whole shell](../../docs-site) on GitHub. How pages are written is on the [next page](writing.md).
